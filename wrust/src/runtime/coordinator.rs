use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::ast::{ASTNode, Program};
use crate::backend::{Backend, DataReference, HandleType, OutputHandle};
use crate::runtime::builtin_registry;
use crate::runtime::env::Env;
use crate::runtime::output_registry::OutputRegistry;
use crate::runtime::render_graph::{GraphNode, NodeType, RenderGraph};
use crate::utils::Result;

pub struct Coordinator {
    ast: Program,
    env: Env,
    graph: RenderGraph,

    backends: Vec<Arc<Mutex<Box<dyn Backend>>>>,
    outputs: OutputRegistry,
    assignments: HashMap<String, usize>,
    exec_order: Vec<String>,

    running: bool,
}

impl Coordinator {
    pub fn new(ast: Program, env: Env) -> Self {
        Self {
            ast,
            env,
            graph: RenderGraph::new(),
            backends: Vec::new(),
            outputs: OutputRegistry::new(),
            assignments: HashMap::new(),
            exec_order: Vec::new(),
            running: false,
        }
    }

    pub fn add_backend(&mut self, backend: Box<dyn Backend>) {
        self.backends.push(Arc::new(Mutex::new(backend)));
    }

    pub fn expose(
        &mut self,
        instance: &str,
        output: &str,
        handle: OutputHandle,
        backend_idx: usize,
    ) {
        self.outputs.register(instance, output, handle, backend_idx);
    }

    pub fn lookup(&self, instance: &str, output: &str) -> Result<DataReference> {
        let location = self.outputs.get(instance, output)?;
        let backend_idx = location.backend_index;

        // Fast path: Get handle from backend (GPU-to-GPU zero-copy transfer)
        {
            let owner = self.backends[backend_idx].lock().unwrap();
            if let Ok(handle) = owner.get_handle(instance, output) {
                // Use HandleType to choose the correct DataReference variant
                let handle_type = handle.handle_type();
                let inner = handle.into_any();

                return Ok(match handle_type {
                    HandleType::Buffer => DataReference::MetalBuffer(inner),
                    HandleType::Texture => DataReference::MetalTexture(inner),
                    HandleType::Sampler => {
                        return Err(crate::WeftError::Runtime(
                            "Sampler handles cannot be used as data references".into(),
                        ));
                    }
                });
            }
        }

        // Slow path: Create ValueGetter for CPU evaluation
        // This wraps get_value_at in a closure for per-pixel evaluation
        let backend = Arc::clone(&self.backends[backend_idx]);
        let instance_name = instance.to_string();
        let output_name = output.to_string();

        let value_getter = Arc::new(move |coords: &HashMap<String, f64>| -> f64 {
            backend
                .lock()
                .unwrap()
                .get_value_at(&instance_name, &output_name, coords)
                .unwrap_or(0.0) // Return 0.0 on error (could log warning)
        });

        Ok(DataReference::ValueGetter(value_getter))
    }

    pub fn compile(&mut self) -> Result<()> {
        let exec_order = self.graph.build(&self.ast, &self.env)?;
        self.exec_order = exec_order.clone();

        self.assign_nodes(&exec_order)?;

        let batches = self.batch_nodes(&exec_order);

        for (backend_idx, node_names) in batches {
            let nodes: Vec<_> = node_names
                .iter()
                .filter_map(|name| self.graph.get_node(name))
                .collect();
            self.backends[backend_idx]
                .lock()
                .unwrap()
                .compile_nodes(&nodes, &self.env, self)?;
        }

        self.running = true;
        Ok(())
    }

    fn assign_nodes(&mut self, exec_order: &[String]) -> Result<()> {
        for node_name in exec_order {
            let node = self.graph.get_node(node_name).ok_or_else(|| {
                crate::WeftError::Runtime(format!("Node not found: {}", node_name))
            })?;

            let backend_idx = if matches!(node.node_type, NodeType::Builtin) {
                self.extract_builtin_name(node)
                    .and_then(|name| builtin_registry::get_builtin_context(&name))
                    .and_then(|ctx| self.find_backend_for_context(&ctx).ok()) // Add .ok() here!
            } else {
                None
            }
            .or_else(|| {
                node.contexts
                    .iter()
                    .next()
                    .and_then(|ctx| self.find_backend_for_context(ctx).ok())
            })
            .unwrap_or(0);

            self.assignments.insert(node_name.clone(), backend_idx);
        }
        Ok(())
    }

    fn extract_builtin_name(&self, node: &GraphNode) -> Option<String> {
        for expr in node.outputs.values() {
            if let ASTNode::Call(call_expr) = expr {
                if let ASTNode::Var(var) = &*call_expr.name {
                    return Some(var.name.clone());
                }
            }
        }
        None
    }

    fn find_backend_for_context(
        &self,
        context: &crate::runtime::backend_registry::Context,
    ) -> Result<usize> {
        for (idx, backend) in self.backends.iter().enumerate() {
            if backend.lock().unwrap().context() == context_to_str(context) {
                return Ok(idx);
            }
        }
        Err(crate::WeftError::Runtime(format!(
            "No backend found for context: {:?}",
            context
        )))
    }
    fn batch_nodes(&self, exec_order: &[String]) -> Vec<(usize, Vec<String>)> {
        let mut batches = Vec::new();
        let mut current_backend: Option<usize> = None;
        let mut current_batch = Vec::new();

        for node_name in exec_order {
            let backend_idx = self.assignments[node_name];

            if Some(backend_idx) != current_backend {
                if !current_batch.is_empty() {
                    batches.push((current_backend.unwrap(), current_batch));
                    current_batch = Vec::new();
                }
                current_backend = Some(backend_idx);
            }
            current_batch.push(node_name.clone());
        }
        if !current_batch.is_empty() {
            batches.push((current_backend.unwrap(), current_batch));
        }

        batches
    }

    pub fn execute(&mut self) -> Result<()> {
        if !self.running {
            return Err(crate::WeftError::Runtime(
                "Cannot execute: program not compiled yet".into(),
            ));
        }

        if self.env.start_time == 0.0 {
            self.env.start();
        }

        self.env.sync_counters();

        for backend in &self.backends {
            backend.lock().unwrap().execute(&self.env)?;
        }

        Ok(())
    }
}

fn context_to_str(context: &crate::runtime::backend_registry::Context) -> &'static str {
    match context {
        crate::runtime::backend_registry::Context::Visual => "visual",
        crate::runtime::backend_registry::Context::Audio => "audio",
        crate::runtime::backend_registry::Context::Compute => "compute",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;
    use std::cell::Cell;

    // Mock backend for testing
    struct MockBackend {
        context: &'static str,
        compiled: Cell<bool>,
        executed: Cell<bool>,
        compile_count: Cell<usize>,
        execute_count: Cell<usize>,
    }

    impl MockBackend {
        fn new(context: &'static str) -> Self {
            Self {
                context,
                compiled: Cell::new(false),
                executed: Cell::new(false),
                compile_count: Cell::new(0),
                execute_count: Cell::new(0),
            }
        }
    }

    impl Backend for MockBackend {
        fn context(&self) -> &str {
            self.context
        }

        fn compile_nodes(
            &mut self,
            _nodes: &[&GraphNode],
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<()> {
            self.compiled.set(true);
            self.compile_count.set(self.compile_count.get() + 1);
            Ok(())
        }

        fn execute(&mut self, _env: &Env) -> Result<()> {
            self.executed.set(true);
            self.execute_count.set(self.execute_count.get() + 1);
            Ok(())
        }

        fn get_handle(&self, instance: &str, output: &str) -> Result<OutputHandle> {
            if instance == "test" && output == "buffer" {
                Ok(OutputHandle::new(42u32, HandleType::Buffer))
            } else if instance == "test" && output == "texture" {
                Ok(OutputHandle::new(vec![1, 2, 3], HandleType::Texture))
            } else if instance == "test" && output == "sampler" {
                Ok(OutputHandle::new((), HandleType::Sampler))
            } else {
                Err(crate::WeftError::Runtime("Handle not found".into()))
            }
        }

        fn get_value_at(
            &self,
            _instance: &str,
            _output: &str,
            _coords: &HashMap<String, f64>,
        ) -> Result<f64> {
            Ok(42.0)
        }
    }

    fn empty_program() -> Program {
        Program { statements: vec![] }
    }

    fn test_env() -> Env {
        Env::new(800, 600)
    }

    #[test]
    fn test_coordinator_new() {
        let prog = empty_program();
        let env = test_env();
        let coord = Coordinator::new(prog, env);

        assert_eq!(coord.backends.len(), 0);
        assert_eq!(coord.running, false);
    }

    #[test]
    fn test_add_backend() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));
        coord.add_backend(Box::new(MockBackend::new("audio")));

        assert_eq!(coord.backends.len(), 2);
    }

    #[test]
    fn test_expose_and_lookup_buffer() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));

        let handle = OutputHandle::new(123u32, HandleType::Buffer);
        coord.expose("test", "buffer", handle, 0);

        let result = coord.lookup("test", "buffer").unwrap();
        match result {
            DataReference::MetalBuffer(_) => (),
            _ => panic!("Expected MetalBuffer"),
        }
    }

    #[test]
    fn test_expose_and_lookup_texture() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));

        let handle = OutputHandle::new(vec![1, 2, 3], HandleType::Texture);
        coord.expose("test", "texture", handle, 0);

        let result = coord.lookup("test", "texture").unwrap();
        match result {
            DataReference::MetalTexture(_) => (),
            _ => panic!("Expected MetalTexture"),
        }
    }

    #[test]
    fn test_lookup_sampler_rejects() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));

        let handle = OutputHandle::new((), HandleType::Sampler);
        coord.expose("test", "sampler", handle, 0);

        let result = coord.lookup("test", "sampler");
        assert!(result.is_err());
    }

    #[test]
    fn test_lookup_value_getter_fallback() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));

        // Expose without a handle (will fall back to value getter)
        let handle = OutputHandle::new((), HandleType::Buffer);
        coord.expose("test", "missing", handle, 0);

        let result = coord.lookup("test", "missing").unwrap();
        match result {
            DataReference::ValueGetter(getter) => {
                let coords = HashMap::new();
                let value = getter(&coords);
                assert_eq!(value, 42.0);
            }
            _ => panic!("Expected ValueGetter"),
        }
    }

    #[test]
    fn test_execute_before_compile_fails() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        let result = coord.execute();
        assert!(result.is_err());
    }

    #[test]
    fn test_compile_sets_running() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));

        assert_eq!(coord.running, false);
        coord.compile().unwrap();
        assert_eq!(coord.running, true);
    }

    #[test]
    fn test_execute_after_compile_succeeds() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));
        coord.compile().unwrap();

        let result = coord.execute();
        assert!(result.is_ok());
    }

    #[test]
    fn test_execute_starts_timer_on_first_call() {
        let prog = empty_program();
        let env = test_env();
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));
        coord.compile().unwrap();

        assert_eq!(coord.env.start_time, 0.0);

        coord.execute().unwrap();

        assert!(coord.env.start_time > 0.0);
    }

    #[test]
    fn test_execute_updates_counters() {
        let prog = empty_program();
        let mut env = test_env();
        env.target_fps = 60.0;
        let mut coord = Coordinator::new(prog, env);

        coord.add_backend(Box::new(MockBackend::new("visual")));
        coord.compile().unwrap();

        coord.env.start();
        coord.env.start_time -= 1.0; // Simulate 1 second ago

        coord.execute().unwrap();
        assert!(coord.env.absframe >= 59 && coord.env.absframe <= 61);
    }
}

use super::backend_registry::Context;
use super::render_graph::{MetaGraph, RenderGraph};
use crate::ast::Program;
use crate::backend::{Backend, DataRef};
use crate::utils::Result;
use crate::Env;
use crate::WeftError;
use std::cell::RefCell;
use std::collections::HashMap;

pub struct Coordinator {
    render_graph: RenderGraph,
    backends: RefCell<Vec<Box<dyn Backend>>>,
    meta_graph: Option<MetaGraph>,
    context_to_backend: HashMap<Context, usize>,
    registry: RefCell<HashMap<String, usize>>,
}

impl Coordinator {
    pub fn new() -> Self {
        Self {
            render_graph: RenderGraph::new(),
            backends: RefCell::new(Vec::new()),
            meta_graph: None,
            context_to_backend: HashMap::new(),
            registry: RefCell::new(HashMap::new()),
        }
    }

    pub fn add_backend(&mut self, backend: Box<dyn Backend>) {
        let context = backend.context();
        let idx = self.backends.borrow().len();
        self.backends.borrow_mut().push(backend);
        self.context_to_backend.insert(context, idx);
    }

    pub fn compile(&mut self, ast: &Program, env: &Env) -> Result<()> {
        let meta_graph = self.render_graph.build(ast, env)?;
        for &subgraph_id in &meta_graph.execution_order {
            let subgraph = &meta_graph.subgraphs[subgraph_id];
            let context = subgraph.context;
            let backend_idx = *self.context_to_backend.get(&context).ok_or_else(|| {
                WeftError::Runtime(format!("No backend registered for context {:?}", context))
            })?;

            self.backends
                .borrow_mut()
                .get_mut(backend_idx)
                .ok_or_else(|| WeftError::Runtime("Backend index out of bounds".to_string()))?
                .compile_subgraph(subgraph, env, self)?;
        }
        self.meta_graph = Some(meta_graph);
        Ok(())
    }

    pub fn execute(&self, env: &Env) -> Result<()> {
        let meta_graph = self.meta_graph.as_ref().ok_or_else(|| {
            WeftError::Runtime("Must call compile() before execute()".to_string())
        })?;

        for &subgraph_id in &meta_graph.execution_order {
            let subgraph = &meta_graph.subgraphs[subgraph_id];
            let context = subgraph.context;
            let backend_idx = *self.context_to_backend.get(&context).ok_or_else(|| {
                WeftError::Runtime(format!("No backend registered for context {:?}", context))
            })?;

            self.backends
                .borrow_mut()
                .get_mut(backend_idx)
                .ok_or_else(|| WeftError::Runtime("Backend index out of bounds".to_string()))?
                .execute_subgraph(subgraph, env, self)?;
        }

        Ok(())
    }

    pub fn expose(&self, instance: &str, output: &str, context: Context) {
        let key = format!("{}@{}", instance, output);
        if let Some(&backend_idx) = self.context_to_backend.get(&context) {
            self.registry.borrow_mut().insert(key, backend_idx);
        }
    }

    pub fn lookup<'a>(&'a self, instance: &str, output: &str) -> Result<DataRef<'a>> {
        let key = format!("{}@{}", instance, output);
        let backend_idx = *self.registry.borrow().get(&key).ok_or_else(|| {
            WeftError::Runtime(format!("No backend registered for {}@{}", instance, output))
        })?;

        let backends = self.backends.borrow();
        let backend = backends
            .get(backend_idx)
            .ok_or_else(|| WeftError::Runtime("Backend index out of bounds".to_string()))?;

        if backend.supports_handles() {
            if let Ok(handle) = backend.get_handle(instance, output) {
                return Ok(DataRef::Handle(handle));
            }
        }

        let instance_owned = instance.to_string();
        let output_owned = output.to_string();

        Ok(DataRef::ValueGetter(Box::new(
            move |coords: &HashMap<String, f64>, env: &Env, coordinator: &Coordinator| {
                let backends = coordinator.backends.borrow();
                let backend = backends
                    .get(backend_idx)
                    .ok_or_else(|| WeftError::Runtime("Backend index out of bounds".to_string()))?;
                backend.get_value_at(&instance_owned, &output_owned, coords, env, coordinator)
            },
        )))
    }

    pub fn render_graph(&self) -> &RenderGraph {
        &self.render_graph
    }

    pub fn meta_graph(&self) -> Option<&MetaGraph> {
        self.meta_graph.as_ref()
    }
}

impl Default for Coordinator {
    fn default() -> Self {
        Self::new()
    }
}

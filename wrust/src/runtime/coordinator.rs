use std::cell::RefCell;
use std::collections::HashMap;

use crate::ast::{ASTNode, Program};
use crate::backend::{Backend, DataReference, OutputHandle};
use crate::runtime::builtin_registry;
use crate::runtime::env::Env;
use crate::runtime::output_registry::OutputRegistry;
use crate::runtime::render_graph::{GraphNode, NodeType, RenderGraph};
use crate::utils::Result;

pub struct Coordinator {
    ast: Program,
    env: Env,
    graph: RenderGraph,

    backends: Vec<RefCell<Box<dyn Backend>>>,
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
        self.backends.push(RefCell::new(backend));
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
        let owner = self.backends[location.backend_index].borrow();

        // Try handle path first (Metal-to-Metal fast path)
        if let Ok(handle) = owner.get_handle(instance, output) {
            // TODO: Distinguish between MetalBuffer and MetalTexture
            return Ok(DataReference::MetalBuffer(handle.downcast::<()>().unwrap()));
        }

        // Fall back to value getter (compatibility path)
        // TODO: Implement value getter wrapper around get_value_at
        Err(crate::WeftError::Runtime(
            "Value getter not yet implemented".into(),
        ))
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
                .borrow_mut()
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
            if backend.borrow().context() == context_to_str(context) {
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
}

fn context_to_str(context: &crate::runtime::backend_registry::Context) -> &'static str {
    match context {
        crate::runtime::backend_registry::Context::Visual => "visual",
        crate::runtime::backend_registry::Context::Audio => "audio",
        crate::runtime::backend_registry::Context::Compute => "compute",
    }
}

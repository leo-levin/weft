use super::backend_registry::{self, Context};
use crate::ast::{ASTNode, BackendExpr, Program};
use crate::utils::Result;
use crate::Env;
use crate::WeftError;
use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use std::collections::{HashMap, HashSet};
#[derive(Debug, Clone)]
pub enum NodeType {
    Expression, // Direct expression: x<val> = me.x + 5
    Spindle,    // Spindle call: blur(img, 5)
    Builtin,    // Built-in: load(), camera(), etc.
}

#[derive(Debug, Clone)]
pub struct GraphNode {
    pub instance_name: String,
    pub node_type: NodeType,
    pub outputs: HashMap<String, ASTNode>,
    pub deps: HashSet<String>,
    pub required_outputs: HashSet<String>,
    pub contexts: HashSet<Context>,
}

pub struct RenderGraph {
    graph: DiGraph<GraphNode, ()>,
    node_indices: HashMap<String, NodeIndex>,
}

impl RenderGraph {
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
            node_indices: HashMap::new(),
        }
    }

    pub fn build(&mut self, ast: &Program, env: &Env) -> Result<Vec<String>> {
        self.collect_instances(ast, env)?;
        self.mark_required_outputs(ast);
        self.extract_deps();
        self.build_edges();
        self.tag_contexts(ast)?;

        let exec_order = self.topo_sort()?;
        Ok(exec_order)
    }

    fn collect_instances(&mut self, ast: &Program, env: &Env) -> Result<()> {
        for stmt in &ast.statements {
            if let ASTNode::InstanceBinding(bind) = stmt {
                let node_type = self.check_node_type(&bind.expr, env);
                let mut outputs = HashMap::new();

                if let ASTNode::Tuple(tuple_expr) = &*bind.expr {
                    for (i, output_name) in bind.outputs.iter().enumerate() {
                        if i < tuple_expr.items.len() {
                            outputs.insert(output_name.clone(), tuple_expr.items[i].clone());
                        }
                    }
                } else {
                    for output_name in &bind.outputs {
                        outputs.insert(output_name.clone(), (*bind.expr).clone());
                    }
                }

                let graph_node = GraphNode {
                    instance_name: bind.name.clone(),
                    node_type,
                    outputs,
                    deps: HashSet::new(),
                    required_outputs: HashSet::new(),
                    contexts: HashSet::new(),
                };
                let idx = self.graph.add_node(graph_node);
                self.node_indices.insert(bind.name.clone(), idx);
            }
        }
        Ok(())
    }

    fn check_node_type(&self, expr: &ASTNode, env: &Env) -> NodeType {
        match expr {
            ASTNode::Call(call_expr) => {
                if let ASTNode::Var(var) = &*call_expr.name {
                    if env.spindles.contains_key(&var.name) {
                        NodeType::Spindle
                    } else {
                        NodeType::Builtin
                    }
                } else {
                    NodeType::Builtin
                }
            }
            _ => NodeType::Expression,
        }
    }

    fn extract_deps(&mut self) {
        let instance_names: Vec<String> = self.node_indices.keys().cloned().collect();

        for name in instance_names {
            let idx = self.node_indices[&name];
            let node = &self.graph[idx];

            let mut deps = HashSet::new();
            for (_output_name, expr) in &node.outputs {
                self.find_deps_in_expr(expr, &mut deps);
            }
            self.graph[idx].deps = deps;
        }
    }

    fn find_deps_in_expr(&self, expr: &ASTNode, deps: &mut HashSet<String>) {
        match expr {
            ASTNode::StrandAccess(access) => {
                if let ASTNode::Var(var) = &*access.base {
                    deps.insert(var.name.clone());
                }
            }
            ASTNode::StrandRemap(remap) => {
                if let ASTNode::Var(var) = &*remap.base {
                    deps.insert(var.name.clone());
                }
                for mapping in &remap.mappings {
                    self.find_deps_in_expr(&mapping.expr, deps);
                }
            }
            ASTNode::Binary(bin) => {
                self.find_deps_in_expr(&bin.left, deps);
                self.find_deps_in_expr(&bin.right, deps);
            }
            ASTNode::Unary(un) => {
                self.find_deps_in_expr(&un.expr, deps);
            }
            ASTNode::Call(call) => {
                for arg in &call.args {
                    self.find_deps_in_expr(arg, deps);
                }
            }
            ASTNode::If(if_expr) => {
                self.find_deps_in_expr(&if_expr.condition, deps);
                self.find_deps_in_expr(&if_expr.then_expr, deps);
                self.find_deps_in_expr(&if_expr.else_expr, deps);
            }
            ASTNode::Tuple(tuple) => {
                for item in &tuple.items {
                    self.find_deps_in_expr(item, deps);
                }
            }
            ASTNode::Index(index) => {
                self.find_deps_in_expr(&index.base, deps);
                self.find_deps_in_expr(&index.index, deps);
            }
            ASTNode::Num(_) | ASTNode::Str(_) | ASTNode::Var(_) | ASTNode::Me(_) => {}
            _ => {}
        }
    }

    fn build_edges(&mut self) {
        for (_name, &node_idx) in &self.node_indices {
            let deps: Vec<String> = self.graph[node_idx].deps.iter().cloned().collect();
            for dep_name in deps {
                if let Some(&dep_idx) = self.node_indices.get(&dep_name) {
                    self.graph.add_edge(dep_idx, node_idx, ());
                }
            }
        }
    }

    fn topo_sort(&self) -> Result<Vec<String>> {
        match toposort(&self.graph, None) {
            Ok(sorted_indices) => {
                let exec_order = sorted_indices
                    .into_iter()
                    .map(|idx| self.graph[idx].instance_name.clone())
                    .collect();
                Ok(exec_order)
            }
            Err(_cycle) => Err(WeftError::Runtime(
                "Circular dependency in graph!".to_string(),
            )),
        }
    }
    fn tag_contexts(&mut self, ast: &Program) -> Result<()> {
        let output_stmts: Vec<&ASTNode> = ast
            .statements
            .iter()
            .filter(|stmt| matches!(stmt, ASTNode::Backend(_)))
            .collect();

        for stmt in output_stmts {
            if let ASTNode::Backend(backend) = stmt {
                let context = self.determine_context(backend)?;
                for arg in &backend.positional_args {
                    self.tag_expr(arg, context);
                }
            }
        }
        Ok(())
    }

    fn determine_context(&self, backend: &BackendExpr) -> Result<Context> {
        backend_registry::get_context(&backend.context)
            .ok_or_else(|| WeftError::Runtime(format!("Unknown backend: {}", backend.context)))
    }

    fn tag_expr(&mut self, expr: &ASTNode, context: Context) {
        match expr {
            ASTNode::StrandAccess(access) => {
                if let ASTNode::Var(var) = &*access.base {
                    self.tag_instance(&var.name, context);
                }
            }
            ASTNode::StrandRemap(remap) => {
                if let ASTNode::Var(var) = &*remap.base {
                    self.tag_instance(&var.name, context);
                }
                for mapping in &remap.mappings {
                    self.tag_expr(&mapping.expr, context);
                }
            }
            ASTNode::Binary(bin) => {
                self.tag_expr(&bin.left, context);
                self.tag_expr(&bin.right, context);
            }
            ASTNode::Unary(un) => {
                self.tag_expr(&un.expr, context);
            }
            ASTNode::Call(call) => {
                for arg in &call.args {
                    self.tag_expr(arg, context);
                }
            }
            ASTNode::If(if_expr) => {
                self.tag_expr(&if_expr.condition, context);
                self.tag_expr(&if_expr.then_expr, context);
                self.tag_expr(&if_expr.else_expr, context);
            }
            ASTNode::Tuple(tuple) => {
                for item in &tuple.items {
                    self.tag_expr(item, context);
                }
            }
            ASTNode::Index(index) => {
                self.tag_expr(&index.base, context);
                self.tag_expr(&index.index, context);
            }
            _ => {}
        }
    }

    fn tag_instance(&mut self, name: &str, context: Context) {
        if let Some(&idx) = self.node_indices.get(name) {
            self.graph[idx].contexts.insert(context);

            let deps: Vec<String> = self.graph[idx].deps.iter().cloned().collect();
            for dep_name in deps {
                self.tag_instance(&dep_name, context);
            }
        }
    }

    pub fn get_node(&self, name: &str) -> Option<&GraphNode> {
        self.node_indices.get(name).map(|&idx| &self.graph[idx])
    }

    fn mark_required_outputs(&mut self, ast: &Program) {
        for stmt in &ast.statements {
            if let ASTNode::Backend(backend) = stmt {
                for arg in &backend.positional_args {
                    self.mark_required_in_expr(arg);
                }
            }
        }
    }

    fn mark_required_in_expr(&mut self, expr: &ASTNode) {
        match expr {
            ASTNode::StrandAccess(access) => {
                if let ASTNode::Var(var) = &*access.base {
                    let inst_name = &var.name;
                    if let ASTNode::Var(out_var) = &*access.out {
                        if let Some(&idx) = self.node_indices.get(inst_name) {
                            self.graph[idx]
                                .required_outputs
                                .insert(out_var.name.clone());
                        }
                    }
                }
            }
            ASTNode::StrandRemap(remap) => {
                if let ASTNode::Var(var) = &*remap.base {
                    if let Some(&idx) = self.node_indices.get(&var.name) {
                        self.graph[idx]
                            .required_outputs
                            .insert(remap.strand.clone());
                    }
                }
                for mapping in &remap.mappings {
                    self.mark_required_in_expr(&mapping.expr);
                }
            }
            ASTNode::Binary(bin) => {
                self.mark_required_in_expr(&bin.left);
                self.mark_required_in_expr(&bin.right);
            }
            ASTNode::Unary(un) => {
                self.mark_required_in_expr(&un.expr);
            }
            ASTNode::Call(call) => {
                for arg in &call.args {
                    self.mark_required_in_expr(arg);
                }
            }
            ASTNode::If(if_expr) => {
                self.mark_required_in_expr(&if_expr.condition);
                self.mark_required_in_expr(&if_expr.then_expr);
                self.mark_required_in_expr(&if_expr.else_expr);
            }
            ASTNode::Tuple(tuple) => {
                for item in &tuple.items {
                    self.mark_required_in_expr(item);
                }
            }
            ASTNode::Index(index) => {
                self.mark_required_in_expr(&index.base);
                self.mark_required_in_expr(&index.index);
            }
            _ => {}
        }
    }
}

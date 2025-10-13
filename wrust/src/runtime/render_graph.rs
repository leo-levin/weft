use super::backend_registry::{self, Context};
use super::builtin_registry;
use crate::ast::{ASTNode, BackendExpr, Program};
use crate::utils::Result;
use crate::Env;
use crate::WeftError;
use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::{DfsPostOrder, EdgeRef, Reversed};
use petgraph::Direction;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeType {
    Normal,
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    Expression,
    Spindle,
    Builtin,
}

#[derive(Debug, Clone)]
pub struct GraphNode {
    pub instance_name: String,
    pub original_name: Option<String>,
    pub node_type: NodeType,
    pub context: Option<Context>,
    pub outputs: HashMap<String, ASTNode>,
    pub deps: HashSet<String>,
    pub output_deps: HashMap<String, Vec<(String, String)>>,
    pub required_outputs: HashSet<String>,
    pub is_duplicate: bool,
    pub typed_by_child: Option<String>,
}

pub struct RenderGraph {
    graph: DiGraph<GraphNode, EdgeType>,
    node_indices: HashMap<String, NodeIndex>,
    duplicate_into: HashMap<String, HashSet<Context>>,
    original_edges: Vec<(String, String)>,
}

#[derive(Debug)]
pub struct Subgraph {
    pub context: Context,
    pub graph: DiGraph<GraphNode, ()>,
    pub node_names: Vec<String>,
    pub execution_order: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Reference {
    pub from_context: Context,
    pub from_node: String,
    pub to_context: Context,
    pub to_node: String,
}

#[derive(Debug)]
pub struct MetaGraph {
    pub subgraphs: HashMap<Context, Subgraph>,
    pub context_dag: DiGraph<Context, ()>,
    pub execution_order: Vec<Context>,
    pub references: Vec<Reference>,
}

impl RenderGraph {
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
            node_indices: HashMap::new(),
            duplicate_into: HashMap::new(),
            original_edges: Vec::new(),
        }
    }

    pub fn build(&mut self, ast: &Program, env: &Env) -> Result<MetaGraph> {
        self.collect_instances(ast, env)?;
        self.build_initial_edges();
        self.phase0_initial_typing(ast, env)?;
        self.phase1_type_propagation()?;
        self.phase2_find_and_process_untyped_components()?;
        self.phase3_build_typed_edges()?;
        self.build_meta_graph()
    }

    fn collect_instances(&mut self, ast: &Program, env: &Env) -> Result<()> {
        for stmt in &ast.statements {
            if let ASTNode::InstanceBinding(bind) = stmt {
                let node_type = check_node_type(&bind.expr, env);
                let mut outputs = HashMap::new();
                let mut output_deps = HashMap::new();
                let mut all_deps = HashSet::new();

                if let ASTNode::Tuple(tuple_expr) = &*bind.expr {
                    for (i, output_name) in bind.outputs.iter().enumerate() {
                        if i < tuple_expr.items.len() {
                            let expr = &tuple_expr.items[i];

                            outputs.insert(output_name.clone(), expr.clone());

                            let mut instance_deps = HashSet::new();
                            let mut output_level_deps = Vec::new();
                            find_deps_in_expr(expr, &mut instance_deps);

                            find_output_deps_in_expr(expr, &mut output_level_deps);

                            all_deps.extend(instance_deps);

                            output_deps.insert(output_name.clone(), output_level_deps);
                        }
                    }
                } else {
                    for output_name in &bind.outputs {
                        outputs.insert(output_name.clone(), (*bind.expr).clone());

                        let mut instance_deps = HashSet::new();
                        let mut output_level_deps = Vec::new();
                        find_deps_in_expr(&bind.expr, &mut instance_deps);

                        find_output_deps_in_expr(&bind.expr, &mut output_level_deps);

                        all_deps.extend(instance_deps);

                        output_deps.insert(output_name.clone(), output_level_deps);
                    }
                }

                let graph_node = GraphNode {
                    instance_name: bind.name.clone(),
                    original_name: None,
                    node_type,
                    context: None,
                    outputs,
                    deps: all_deps,
                    output_deps,
                    required_outputs: HashSet::new(),
                    is_duplicate: false,
                    typed_by_child: None,
                };

                let idx = self.graph.add_node(graph_node);

                self.node_indices.insert(bind.name.clone(), idx);
            }
        }
        Ok(())
    }

    fn build_initial_edges(&mut self) {
        let mut edges_to_add = Vec::new();

        for (name, &node_idx) in &self.node_indices {
            let deps = self.graph[node_idx].deps.clone();
            for dep_name in deps {
                if self.node_indices.contains_key(&dep_name) {
                    self.original_edges.push((dep_name.clone(), name.clone()));
                    edges_to_add.push((dep_name, name.clone()));
                }
            }
        }

        for (child, parent) in edges_to_add {
            if let (Some(&child_idx), Some(&parent_idx)) = (
                self.node_indices.get(&child),
                self.node_indices.get(&parent),
            ) {
                self.graph.add_edge(child_idx, parent_idx, EdgeType::Normal);
            }
        }
    }

    fn phase0_initial_typing(&mut self, ast: &Program, env: &Env) -> Result<()> {
        // Phase 0a: Type inherent builtins from builtin_registry
        let all_nodes: Vec<NodeIndex> = self.graph.node_indices().collect();
        for node_idx in all_nodes {
            let node = &self.graph[node_idx];
            if node.node_type == NodeType::Builtin {
                // Extract builtin name from the Call expression
                if let Some(builtin_name) = self.extract_builtin_name(node) {
                    if let Some(context) = builtin_registry::get_builtin_context(&builtin_name) {
                        self.graph[node_idx].context = Some(context);
                    }
                }
            }
        }

        // Phase 0b: Type from backend statements
        for stmt in &ast.statements {
            if let ASTNode::Backend(backend) = stmt {
                let context = backend_registry::get_context(&backend.context).ok_or_else(|| {
                    WeftError::Runtime(format!("Unknown backend: {}", backend.context))
                })?;

                for arg in &backend.positional_args {
                    self.type_expr_as(arg, context);
                }
            }
        }
        Ok(())
    }

    fn type_expr_as(&mut self, expr: &ASTNode, context: Context) {
        match expr {
            ASTNode::StrandAccess(access) => {
                if let ASTNode::Var(var) = &*access.base {
                    self.type_node(&var.name, context);
                }
            }
            ASTNode::StrandRemap(remap) => {
                if let ASTNode::Var(var) = &*remap.base {
                    self.type_node(&var.name, context);
                }
                for mapping in &remap.mappings {
                    self.type_expr_as(&mapping.expr, context);
                }
            }
            ASTNode::Binary(bin) => {
                self.type_expr_as(&bin.left, context);
                self.type_expr_as(&bin.right, context);
            }
            ASTNode::Unary(un) => {
                self.type_expr_as(&un.expr, context);
            }
            ASTNode::Call(call) => {
                for arg in &call.args {
                    self.type_expr_as(arg, context);
                }
            }
            ASTNode::If(if_expr) => {
                self.type_expr_as(&if_expr.condition, context);
                self.type_expr_as(&if_expr.then_expr, context);
                self.type_expr_as(&if_expr.else_expr, context);
            }
            ASTNode::Tuple(tuple) => {
                for item in &tuple.items {
                    self.type_expr_as(item, context);
                }
            }
            ASTNode::Index(index) => {
                self.type_expr_as(&index.base, context);
                self.type_expr_as(&index.index, context);
            }
            _ => {}
        }
    }

    fn type_node(&mut self, name: &str, context: Context) {
        if let Some(&idx) = self.node_indices.get(name) {
            self.graph[idx].context = Some(context);
        }
    }

    pub fn get_node(&self, name: &str) -> Option<&GraphNode> {
        self.node_indices.get(name).map(|&idx| &self.graph[idx])
    }

    fn extract_builtin_name(&self, node: &GraphNode) -> Option<String> {
        // Look through all outputs to find a Call expression
        for expr in node.outputs.values() {
            if let ASTNode::Call(call) = expr {
                if let ASTNode::Var(var) = &*call.name {
                    return Some(var.name.clone());
                }
            }
        }
        None
    }

    fn phase1_type_propagation(&mut self) -> Result<()> {
        // Phase 1a: Bottom-up propagation (from dependents to dependencies)
        let mut changed = true;
        while changed {
            changed = false;
            let all_nodes: Vec<NodeIndex> = self.graph.node_indices().collect();

            for node_idx in all_nodes {
                if self.graph[node_idx].context.is_some() {
                    continue;
                }

                let dependents: Vec<NodeIndex> = self
                    .graph
                    .neighbors_directed(node_idx, Direction::Outgoing)
                    .collect();

                if dependents.is_empty() {
                    continue;
                }

                let dependent_contexts: HashSet<Context> = dependents
                    .iter()
                    .filter_map(|&idx| self.graph[idx].context)
                    .collect();

                if dependent_contexts.len() == 1 {
                    let context = *dependent_contexts.iter().next().unwrap();
                    self.graph[node_idx].context = Some(context);
                    changed = true;
                }
            }
        }

        // Phase 1b: Top-down propagation (from dependencies to dependents)
        // This handles unreachable nodes that depend on typed nodes
        changed = true;
        while changed {
            changed = false;
            let all_nodes: Vec<NodeIndex> = self.graph.node_indices().collect();

            for node_idx in all_nodes {
                if self.graph[node_idx].context.is_some() {
                    continue;
                }

                let dependencies: Vec<NodeIndex> = self
                    .graph
                    .neighbors_directed(node_idx, Direction::Incoming)
                    .collect();

                if dependencies.is_empty() {
                    continue;
                }

                let dependency_contexts: HashSet<Context> = dependencies
                    .iter()
                    .filter_map(|&idx| self.graph[idx].context)
                    .collect();

                if dependency_contexts.len() == 1 {
                    let context = *dependency_contexts.iter().next().unwrap();
                    self.graph[node_idx].context = Some(context);
                    changed = true;
                }
            }
        }

        Ok(())
    }

    fn phase2_find_and_process_untyped_components(&mut self) -> Result<()> {
        let untyped_nodes: Vec<NodeIndex> = self
            .graph
            .node_indices()
            .filter(|&idx| self.graph[idx].context.is_none())
            .collect();

        let mut visited = HashSet::new();

        for &start_node in &untyped_nodes {
            if visited.contains(&start_node) {
                continue;
            }

            let (component, has_typed_dep) = self.find_untyped_component(start_node, &mut visited);
            let target_contexts = self.find_component_target_contexts(&component);

            if has_typed_dep {
                // Cannot duplicate - has dependencies on typed nodes
                // Choose context from typed dep or first target
                let chosen = self.pick_context(&component, &target_contexts);
                for &node_idx in &component {
                    self.graph[node_idx].context = Some(chosen);
                }
            } else if target_contexts.len() > 1 {
                // Can duplicate - no typed dependencies
                for &node_idx in &component {
                    let node_name = self.graph[node_idx].instance_name.clone();
                    self.duplicate_into
                        .insert(node_name, target_contexts.clone());
                }
            } else if target_contexts.len() == 1 {
                // Single context, just assign
                let context = *target_contexts.iter().next().unwrap();
                for &node_idx in &component {
                    self.graph[node_idx].context = Some(context);
                }
            }
        }

        self.create_duplicates()?;
        Ok(())
    }

    fn find_untyped_component(
        &self,
        start: NodeIndex,
        visited: &mut HashSet<NodeIndex>,
    ) -> (Vec<NodeIndex>, bool) {
        let mut component = Vec::new();
        let mut stack = vec![start];

        // First pass: find all connected untyped nodes
        while let Some(node_idx) = stack.pop() {
            if visited.contains(&node_idx) {
                continue;
            }

            if self.graph[node_idx].context.is_some() {
                continue;
            }

            visited.insert(node_idx);
            component.push(node_idx);

            for neighbor in self.graph.neighbors_undirected(node_idx) {
                if !visited.contains(&neighbor) && self.graph[neighbor].context.is_none() {
                    stack.push(neighbor);
                }
            }
        }

        // Second pass: check if any node in component has typed dependencies
        let mut has_typed_dep = false;
        for &node_idx in &component {
            for dependency in self.graph.neighbors_directed(node_idx, Direction::Incoming) {
                if self.graph[dependency].context.is_some() {
                    has_typed_dep = true;
                    break;
                }
            }
            if has_typed_dep {
                break;
            }
        }

        (component, has_typed_dep)
    }

    fn find_component_target_contexts(&self, component: &[NodeIndex]) -> HashSet<Context> {
        let mut contexts = HashSet::new();

        for &node_idx in component {
            for dependent in self.graph.neighbors_directed(node_idx, Direction::Outgoing) {
                if let Some(ctx) = self.graph[dependent].context {
                    contexts.insert(ctx);
                }
            }
        }

        contexts
    }

    fn pick_context(&self, component: &[NodeIndex], targets: &HashSet<Context>) -> Context {
        // Find first typed dependency's context
        for &node_idx in component {
            for dependency in self.graph.neighbors_directed(node_idx, Direction::Incoming) {
                if let Some(ctx) = self.graph[dependency].context {
                    return ctx;
                }
            }
        }

        // Fallback to first target, prioritized by context priority
        targets
            .iter()
            .min_by_key(|ctx| ctx.priority())
            .copied()
            .unwrap_or(Context::Compute)
    }

    fn create_duplicates(&mut self) -> Result<()> {
        let mut new_graph = DiGraph::new();
        let mut new_node_indices = HashMap::new();

        for (name, &old_idx) in &self.node_indices {
            let old_node = &self.graph[old_idx];

            if let Some(contexts) = self.duplicate_into.get(name) {
                for context in contexts {
                    let new_name = format!("{}${}", name, context.name().to_lowercase());
                    let new_node = GraphNode {
                        instance_name: new_name.clone(),
                        original_name: Some(name.clone()),
                        node_type: old_node.node_type,
                        context: Some(*context),
                        outputs: old_node.outputs.clone(),
                        deps: old_node.deps.clone(),
                        output_deps: old_node.output_deps.clone(),
                        required_outputs: old_node.required_outputs.clone(),
                        is_duplicate: true,
                        typed_by_child: old_node.typed_by_child.clone(),
                    };
                    let new_idx = new_graph.add_node(new_node);
                    new_node_indices.insert(new_name, new_idx);
                }
            } else {
                let new_node = old_node.clone();
                let new_idx = new_graph.add_node(new_node);
                new_node_indices.insert(name.clone(), new_idx);
            }
        }

        self.graph = new_graph;
        self.node_indices = new_node_indices;

        Ok(())
    }

    fn phase3_build_typed_edges(&mut self) -> Result<()> {
        self.graph.clear_edges();

        let original_edges = self.original_edges.clone();

        for (child_name, parent_name) in original_edges {
            let child_was_duplicated = self.duplicate_into.contains_key(&child_name);
            let parent_was_duplicated = self.duplicate_into.contains_key(&parent_name);

            if child_was_duplicated && parent_was_duplicated {
                let contexts = self.duplicate_into[&child_name].clone();

                for context in contexts {
                    let child_concrete =
                        format!("{}${}", child_name, context.name().to_lowercase());
                    let parent_concrete =
                        format!("{}${}", parent_name, context.name().to_lowercase());

                    if let (Some(&child_idx), Some(&parent_idx)) = (
                        self.node_indices.get(&child_concrete),
                        self.node_indices.get(&parent_concrete),
                    ) {
                        self.graph.add_edge(child_idx, parent_idx, EdgeType::Normal);
                    }
                }
            } else {
                let child_nodes = self.get_concrete_nodes(&child_name);
                let parent_nodes = self.get_concrete_nodes(&parent_name);

                for &child_idx in &child_nodes {
                    let child_ctx = self.graph[child_idx].context;

                    for &parent_idx in &parent_nodes {
                        let parent_ctx = self.graph[parent_idx].context;

                        // If child was duplicated, only connect to parents with matching context
                        // If parent was duplicated, only connect from children with matching context
                        if (child_was_duplicated || parent_was_duplicated)
                            && child_ctx != parent_ctx
                        {
                            continue;
                        }

                        self.add_edge(child_idx, parent_idx, &child_name, &parent_name)?;
                    }
                }
            }
        }

        Ok(())
    }
    fn get_concrete_nodes(&self, original_name: &str) -> Vec<NodeIndex> {
        if self.duplicate_into.contains_key(original_name) {
            let contexts = &self.duplicate_into[original_name];
            contexts
                .iter()
                .filter_map(|ctx| {
                    let concrete_name = format!("{}${}", original_name, ctx.name().to_lowercase());

                    self.node_indices.get(&concrete_name).copied()
                })
                .collect()
        } else {
            self.node_indices
                .get(original_name)
                .copied()
                .into_iter()
                .collect()
        }
    }
    fn add_edge(
        &mut self,
        child_idx: NodeIndex,
        parent_idx: NodeIndex,
        _child_original: &str,
        _parent_original: &str,
    ) -> Result<()> {
        let child_context = self.graph[child_idx].context;
        let parent_context = self.graph[parent_idx].context;

        let edge_type = if child_context == parent_context {
            EdgeType::Normal
        } else {
            EdgeType::Reference
        };

        self.graph.add_edge(child_idx, parent_idx, edge_type);
        Ok(())
    }
    fn build_meta_graph(&self) -> Result<MetaGraph> {
        let (subgraphs, references) = self.extract_subgraphs()?;
        let (context_dag, execution_order) = self.build_context_dag(&subgraphs, &references)?;

        Ok(MetaGraph {
            subgraphs,
            context_dag,
            execution_order,
            references,
        })
    }

    fn extract_subgraphs(&self) -> Result<(HashMap<Context, Subgraph>, Vec<Reference>)> {
        let mut nodes_by_context: HashMap<Context, Vec<NodeIndex>> = HashMap::new();

        for idx in self.graph.node_indices() {
            if let Some(context) = self.graph[idx].context {
                nodes_by_context.entry(context).or_default().push(idx);
            }
        }

        let mut subgraphs = HashMap::new();
        let mut references = Vec::new();

        for (context, node_indices) in nodes_by_context {
            let mut subgraph = DiGraph::new();
            let mut old_to_new = HashMap::new();
            let mut node_names = Vec::new();

            for &old_idx in &node_indices {
                let node = self.graph[old_idx].clone();
                node_names.push(node.instance_name.clone());
                let new_idx = subgraph.add_node(node);
                old_to_new.insert(old_idx, new_idx);
            }

            for &old_idx in &node_indices {
                for edge in self.graph.edges(old_idx) {
                    match edge.weight() {
                        EdgeType::Normal => {
                            if let (Some(&src), Some(&tgt)) =
                                (old_to_new.get(&old_idx), old_to_new.get(&edge.target()))
                            {
                                subgraph.add_edge(src, tgt, ());
                            }
                        }
                        EdgeType::Reference => {
                            let from_node = &self.graph[old_idx].instance_name;
                            let to_node = &self.graph[edge.target()].instance_name;

                            // Skip edges to untyped nodes (dead code)
                            if let Some(to_context) = self.graph[edge.target()].context {
                                // Reference semantics: from_context (dependent) references to_context (provider)
                                // Edge direction: provider_node -> dependent_node
                                // So we swap: the dependent is to_context, provider is context
                                references.push(Reference {
                                    from_context: to_context, // the dependent context
                                    from_node: to_node.clone(),
                                    to_context: context, // the provider context
                                    to_node: from_node.clone(),
                                });
                            }
                        }
                    }
                }
            }

            let execution_order = toposort(&subgraph, None)
                .map_err(|_| WeftError::Runtime(format!("Cycle in {} subgraph", context.name())))?
                .into_iter()
                .map(|idx| subgraph[idx].instance_name.clone())
                .collect();

            subgraphs.insert(
                context,
                Subgraph {
                    context,
                    graph: subgraph,
                    node_names,
                    execution_order,
                },
            );
        }

        Ok((subgraphs, references))
    }

    fn build_context_dag(
        &self,
        subgraphs: &HashMap<Context, Subgraph>,
        references: &[Reference],
    ) -> Result<(DiGraph<Context, ()>, Vec<Context>)> {
        let mut context_dag = DiGraph::new();
        let mut ctx_to_idx = HashMap::new();

        for &ctx in subgraphs.keys() {
            let idx = context_dag.add_node(ctx);
            ctx_to_idx.insert(ctx, idx);
        }

        // First pass: collect all edges and identify bidirectional dependencies
        let mut edge_map: HashMap<(Context, Context), Vec<&Reference>> = HashMap::new();
        for reference in references {
            let edge = (reference.from_context, reference.to_context);
            edge_map.entry(edge).or_default().push(reference);
        }

        // Second pass: add edges, breaking cycles using priority
        let mut added_edges = HashSet::new();
        for reference in references {
            let edge = (reference.from_context, reference.to_context);
            let reverse_edge = (reference.to_context, reference.from_context);

            // Skip if we've already added this edge
            if added_edges.contains(&edge) {
                continue;
            }

            // If both directions exist, only add the one where the provider has higher priority
            if edge_map.contains_key(&reverse_edge) && !added_edges.contains(&reverse_edge) {
                // Provider context has higher priority (lower ordinal value) = should run first
                // Edge direction: to_context -> from_context means from_context depends on to_context
                // So to_context is the provider
                //
                // Only add this edge if the provider (to_context) has higher priority than the dependent (from_context)
                // Higher priority = lower ordinal value
                if reference.to_context as u8 > reference.from_context as u8 {
                    // The provider has LOWER priority, so skip this edge
                    continue;
                }
            }

            let from_idx = ctx_to_idx[&reference.from_context];
            let to_idx = ctx_to_idx[&reference.to_context];
            context_dag.add_edge(to_idx, from_idx, ());
            added_edges.insert(edge);
        }

        let execution_order = toposort(&context_dag, None)
            .map_err(|_| WeftError::Runtime("Circular dependency between contexts".to_string()))?
            .into_iter()
            .map(|idx| context_dag[idx])
            .collect();

        Ok((context_dag, execution_order))
    }
}

fn find_deps_in_expr(expr: &ASTNode, deps: &mut HashSet<String>) {
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
                find_deps_in_expr(&mapping.expr, deps);
            }
        }
        ASTNode::Binary(bin) => {
            find_deps_in_expr(&bin.left, deps);
            find_deps_in_expr(&bin.right, deps);
        }
        ASTNode::Unary(un) => {
            find_deps_in_expr(&un.expr, deps);
        }
        ASTNode::Call(call) => {
            for arg in &call.args {
                find_deps_in_expr(arg, deps);
            }
        }
        ASTNode::If(if_expr) => {
            find_deps_in_expr(&if_expr.condition, deps);
            find_deps_in_expr(&if_expr.then_expr, deps);
            find_deps_in_expr(&if_expr.else_expr, deps);
        }
        ASTNode::Tuple(tuple) => {
            for item in &tuple.items {
                find_deps_in_expr(item, deps);
            }
        }
        ASTNode::Index(index) => {
            find_deps_in_expr(&index.base, deps);
            find_deps_in_expr(&index.index, deps);
        }
        ASTNode::Num(_) | ASTNode::Str(_) | ASTNode::Var(_) | ASTNode::Me(_) => {}
        _ => {}
    }
}

fn find_output_deps_in_expr(expr: &ASTNode, deps: &mut Vec<(String, String)>) {
    match expr {
        ASTNode::StrandAccess(access) => {
            if let ASTNode::Var(base_var) = &*access.base {
                if let ASTNode::Var(out_var) = &*access.out {
                    deps.push((base_var.name.clone(), out_var.name.clone()));
                }
            }
        }
        ASTNode::StrandRemap(remap) => {
            if let ASTNode::Var(base_var) = &*remap.base {
                deps.push((base_var.name.clone(), remap.strand.clone()));
            }
            for mapping in &remap.mappings {
                find_output_deps_in_expr(&mapping.expr, deps);
            }
        }
        ASTNode::Binary(bin) => {
            find_output_deps_in_expr(&bin.left, deps);
            find_output_deps_in_expr(&bin.right, deps);
        }
        ASTNode::Unary(un) => {
            find_output_deps_in_expr(&un.expr, deps);
        }
        ASTNode::Call(call) => {
            for arg in &call.args {
                find_output_deps_in_expr(arg, deps);
            }
        }
        ASTNode::If(if_expr) => {
            find_output_deps_in_expr(&if_expr.condition, deps);
            find_output_deps_in_expr(&if_expr.then_expr, deps);
            find_output_deps_in_expr(&if_expr.else_expr, deps);
        }
        ASTNode::Tuple(tuple) => {
            for item in &tuple.items {
                find_output_deps_in_expr(item, deps);
            }
        }
        ASTNode::Index(index) => {
            find_output_deps_in_expr(&index.base, deps);
            find_output_deps_in_expr(&index.index, deps);
        }
        _ => {}
    }
}
fn check_node_type(expr: &ASTNode, env: &Env) -> NodeType {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;

    fn var(name: &str) -> ASTNode {
        ASTNode::Var(VarExpr {
            name: name.to_string(),
        })
    }

    fn num(value: f64) -> ASTNode {
        ASTNode::Num(NumExpr { v: value })
    }

    fn instance_binding(name: &str, outputs: Vec<&str>, expr: ASTNode) -> ASTNode {
        ASTNode::InstanceBinding(InstanceBindExpr {
            name: name.to_string(),
            outputs: outputs.iter().map(|s| s.to_string()).collect(),
            expr: Box::new(expr),
        })
    }

    fn strand_access(base: &str, out: &str) -> ASTNode {
        ASTNode::StrandAccess(StrandAccessExpr {
            base: Box::new(var(base)),
            out: Box::new(var(out)),
        })
    }

    fn backend(context: &str, positional_args: Vec<ASTNode>) -> ASTNode {
        ASTNode::Backend(BackendExpr {
            context: context.to_string(),
            args: vec![],
            named_args: HashMap::new(),
            positional_args,
        })
    }

    fn program(statements: Vec<ASTNode>) -> Program {
        Program { statements }
    }

    fn test_env() -> Env {
        Env::new(800, 600)
    }

    #[test]
    fn test_empty_program() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert!(meta.subgraphs.is_empty());
    }

    #[test]
    fn test_single_context_simple() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(42.0)),
            backend("display", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert_eq!(meta.subgraphs.len(), 1);
        assert!(meta.subgraphs.contains_key(&Context::Visual));
        assert_eq!(meta.execution_order.len(), 1);
        assert_eq!(meta.execution_order[0], Context::Visual);
        assert!(meta.references.is_empty());
    }

    #[test]
    fn test_single_context_chain() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], strand_access("a", "x")),
            instance_binding("c", vec!["z"], strand_access("b", "y")),
            backend("display", vec![strand_access("c", "z")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        let visual = &meta.subgraphs[&Context::Visual];
        assert_eq!(visual.execution_order.len(), 3);
        assert_eq!(visual.execution_order[0], "a");
        assert_eq!(visual.execution_order[1], "b");
        assert_eq!(visual.execution_order[2], "c");
    }

    #[test]
    fn test_two_independent_contexts() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], num(2.0)),
            backend("display", vec![strand_access("a", "x")]),
            backend("play", vec![strand_access("b", "y")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert_eq!(meta.subgraphs.len(), 2);
        assert!(meta.subgraphs.contains_key(&Context::Visual));
        assert!(meta.subgraphs.contains_key(&Context::Audio));
        assert!(meta.references.is_empty());
    }

    #[test]
    fn test_shared_computation_gets_duplicated() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("shared", vec!["val"], num(42.0)),
            instance_binding("visual_out", vec!["color"], strand_access("shared", "val")),
            instance_binding("audio_out", vec!["amp"], strand_access("shared", "val")),
            backend("display", vec![strand_access("visual_out", "color")]),
            backend("play", vec![strand_access("audio_out", "amp")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert_eq!(meta.subgraphs.len(), 2);
        let visual = &meta.subgraphs[&Context::Visual];
        assert!(visual
            .node_names
            .iter()
            .any(|n| n.contains("shared") && n.contains("visual")));
        let audio = &meta.subgraphs[&Context::Audio];
        assert!(audio
            .node_names
            .iter()
            .any(|n| n.contains("shared") && n.contains("audio")));
        assert!(meta.references.is_empty());
    }

    #[test]
    fn test_cross_context_reference() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("visual_data", vec!["brightness"], num(0.5)),
            instance_binding(
                "audio_out",
                vec!["tone"],
                strand_access("visual_data", "brightness"),
            ),
            backend("display", vec![strand_access("visual_data", "brightness")]),
            backend("play", vec![strand_access("audio_out", "tone")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert_eq!(meta.subgraphs.len(), 2);
        assert!(!meta.references.is_empty());
        let ref_exists = meta
            .references
            .iter()
            .any(|r| r.from_context == Context::Audio && r.to_context == Context::Visual);
        assert!(ref_exists, "Expected Audio -> Visual reference");
        assert_eq!(meta.execution_order[0], Context::Visual);
        assert_eq!(meta.execution_order[1], Context::Audio);
    }

    #[test]
    fn test_audio_visual_audio_chain() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("audio1", vec!["freq"], num(440.0)),
            instance_binding("visual", vec!["color"], strand_access("audio1", "freq")),
            instance_binding("audio2", vec!["amp"], strand_access("visual", "color")),
            backend("play", vec![strand_access("audio1", "freq")]),
            backend("display", vec![strand_access("visual", "color")]),
            backend("play", vec![strand_access("audio2", "amp")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert!(meta.subgraphs.contains_key(&Context::Audio));
        assert!(meta.subgraphs.contains_key(&Context::Visual));
        let audio = &meta.subgraphs[&Context::Audio];
        assert!(audio.node_names.contains(&"audio1".to_string()));
        assert!(audio.node_names.contains(&"audio2".to_string()));
        let visual = &meta.subgraphs[&Context::Visual];
        assert!(visual.node_names.contains(&"visual".to_string()));
    }

    #[test]
    fn test_diamond_dependency() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("root", vec!["val"], num(10.0)),
            instance_binding("left", vec!["a"], strand_access("root", "val")),
            instance_binding("right", vec!["b"], strand_access("root", "val")),
            instance_binding("merge", vec!["c"], strand_access("left", "a")),
            backend("display", vec![strand_access("merge", "c")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        let visual = &meta.subgraphs[&Context::Visual];
        let pos = |name: &str| {
            visual
                .execution_order
                .iter()
                .position(|n| n == name)
                .unwrap()
        };
        assert!(pos("root") < pos("left"));
        assert!(pos("root") < pos("right"));
        assert!(pos("left") < pos("merge"));
    }

    #[test]
    fn test_deep_dependency_chain() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["x"], strand_access("a", "x")),
            instance_binding("c", vec!["x"], strand_access("b", "x")),
            instance_binding("d", vec!["x"], strand_access("c", "x")),
            instance_binding("e", vec!["x"], strand_access("d", "x")),
            backend("display", vec![strand_access("e", "x")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        let visual = &meta.subgraphs[&Context::Visual];
        assert_eq!(visual.execution_order, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn test_self_reference_fails() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], strand_access("a", "x")),
            backend("display", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_err());
    }

    #[test]
    fn test_circular_dependency_fails() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], strand_access("b", "y")),
            instance_binding("b", vec!["y"], strand_access("a", "x")),
            backend("display", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_err());
    }

    #[test]
    fn test_complex_multi_context_web() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("base", vec!["val"], num(1.0)),
            instance_binding("v1", vec!["x"], strand_access("base", "val")),
            instance_binding("v2", vec!["y"], strand_access("v1", "x")),
            instance_binding("a1", vec!["z"], strand_access("base", "val")),
            instance_binding("a2", vec!["w"], strand_access("a1", "z")),
            backend("display", vec![strand_access("v2", "y")]),
            backend("play", vec![strand_access("a2", "w")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        let visual = &meta.subgraphs[&Context::Visual];
        let audio = &meta.subgraphs[&Context::Audio];
        assert!(visual.node_names.iter().any(|n| n.contains("base")));
        assert!(audio.node_names.iter().any(|n| n.contains("base")));
        assert!(meta.references.is_empty());
    }

    #[test]
    fn test_reference_edge_creates_context_dependency() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("source", vec!["data"], num(100.0)),
            instance_binding("derived", vec!["result"], strand_access("source", "data")),
            backend("display", vec![strand_access("source", "data")]),
            backend("play", vec![strand_access("derived", "result")]),
        ]);
        let env = test_env();
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        let meta = result.unwrap();
        assert!(!meta.references.is_empty());
        let visual_pos = meta
            .execution_order
            .iter()
            .position(|&c| c == Context::Visual)
            .unwrap();
        let audio_pos = meta
            .execution_order
            .iter()
            .position(|&c| c == Context::Audio)
            .unwrap();
        assert!(visual_pos < audio_pos);
    }
}

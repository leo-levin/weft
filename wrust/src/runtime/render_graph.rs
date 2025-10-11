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
    pub output_deps: HashMap<String, Vec<(String, String)>>, // output_name -> [(instance, strand)]
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
        self.propagate_required_outputs();
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
                let mut output_deps = HashMap::new();
                let mut all_deps = HashSet::new();

                if let ASTNode::Tuple(tuple_expr) = &*bind.expr {
                    for (i, output_name) in bind.outputs.iter().enumerate() {
                        if i < tuple_expr.items.len() {
                            let expr = &tuple_expr.items[i];
                            outputs.insert(output_name.clone(), expr.clone());

                            let mut instance_deps = HashSet::new();
                            let mut output_level_deps = Vec::new();
                            self.find_deps_in_expr(expr, &mut instance_deps);
                            self.find_output_deps_in_expr(expr, &mut output_level_deps);

                            all_deps.extend(instance_deps);
                            output_deps.insert(output_name.clone(), output_level_deps);
                        }
                    }
                } else {
                    for output_name in &bind.outputs {
                        outputs.insert(output_name.clone(), (*bind.expr).clone());

                        let mut instance_deps = HashSet::new();
                        let mut output_level_deps = Vec::new();
                        self.find_deps_in_expr(&bind.expr, &mut instance_deps);
                        self.find_output_deps_in_expr(&bind.expr, &mut output_level_deps);

                        all_deps.extend(instance_deps);
                        output_deps.insert(output_name.clone(), output_level_deps);
                    }
                }

                let graph_node = GraphNode {
                    instance_name: bind.name.clone(),
                    node_type,
                    outputs,
                    deps: all_deps,
                    output_deps,
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

    fn propagate_required_outputs(&mut self) {
        let mut changed = true;
        while changed {
            changed = false;

            let instance_names: Vec<String> = self.node_indices.keys().cloned().collect();

            for name in instance_names {
                let idx = self.node_indices[&name];

                let required_outputs: Vec<String> = self.graph[idx].required_outputs.iter().cloned().collect();
                let output_deps = self.graph[idx].output_deps.clone();

                for output_name in required_outputs {
                    if let Some(deps_to_mark) = output_deps.get(&output_name) {
                        for (instance_name, strand_name) in deps_to_mark {
                            if let Some(&dep_idx) = self.node_indices.get(instance_name) {
                                if self.graph[dep_idx].required_outputs.insert(strand_name.clone()) {
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn find_output_deps_in_expr(&self, expr: &ASTNode, deps: &mut Vec<(String, String)>) {
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
                    self.find_output_deps_in_expr(&mapping.expr, deps);
                }
            }
            ASTNode::Binary(bin) => {
                self.find_output_deps_in_expr(&bin.left, deps);
                self.find_output_deps_in_expr(&bin.right, deps);
            }
            ASTNode::Unary(un) => {
                self.find_output_deps_in_expr(&un.expr, deps);
            }
            ASTNode::Call(call) => {
                for arg in &call.args {
                    self.find_output_deps_in_expr(arg, deps);
                }
            }
            ASTNode::If(if_expr) => {
                self.find_output_deps_in_expr(&if_expr.condition, deps);
                self.find_output_deps_in_expr(&if_expr.then_expr, deps);
                self.find_output_deps_in_expr(&if_expr.else_expr, deps);
            }
            ASTNode::Tuple(tuple) => {
                for item in &tuple.items {
                    self.find_output_deps_in_expr(item, deps);
                }
            }
            ASTNode::Index(index) => {
                self.find_output_deps_in_expr(&index.base, deps);
                self.find_output_deps_in_expr(&index.index, deps);
            }
            _ => {}
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;

    // Helper functions to build test AST nodes
    fn var(name: &str) -> ASTNode {
        ASTNode::Var(VarExpr {
            name: name.to_string(),
        })
    }

    fn num(value: f64) -> ASTNode {
        ASTNode::Num(NumExpr { v: value })
    }

    fn binary(left: ASTNode, op: &str, right: ASTNode) -> ASTNode {
        ASTNode::Binary(BinaryExpr {
            op: op.to_string(),
            left: Box::new(left),
            right: Box::new(right),
        })
    }

    fn call(name: &str, args: Vec<ASTNode>) -> ASTNode {
        ASTNode::Call(CallExpr {
            name: Box::new(var(name)),
            args,
        })
    }

    fn strand_access(base: &str, out: &str) -> ASTNode {
        ASTNode::StrandAccess(StrandAccessExpr {
            base: Box::new(var(base)),
            out: Box::new(var(out)),
        })
    }

    fn strand_remap(base: &str, strand: &str, mappings: Vec<(ASTNode, ASTNode)>) -> ASTNode {
        ASTNode::StrandRemap(StrandRemapExpr {
            base: Box::new(var(base)),
            strand: strand.to_string(),
            mappings: mappings
                .into_iter()
                .map(|(axis, expr)| AxisMapping {
                    axis: Box::new(axis),
                    expr: Box::new(expr),
                })
                .collect(),
        })
    }

    fn instance_binding(name: &str, outputs: Vec<&str>, expr: ASTNode) -> ASTNode {
        ASTNode::InstanceBinding(InstanceBindExpr {
            name: name.to_string(),
            outputs: outputs.iter().map(|s| s.to_string()).collect(),
            expr: Box::new(expr),
        })
    }

    fn tuple(items: Vec<ASTNode>) -> ASTNode {
        ASTNode::Tuple(TupleExpr { items })
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

    fn test_env_with_spindle(spindle_name: &str) -> Env {
        let mut env = test_env();
        env.spindles.insert(
            spindle_name.to_string(),
            SpindleDef {
                name: spindle_name.to_string(),
                inputs: vec!["in".to_string()],
                outputs: vec!["out".to_string()],
                body: Box::new(var("in")),
            },
        );
        env
    }

    #[test]
    fn test_empty_graph() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Vec::<String>::new());
    }

    #[test]
    fn test_single_instance_expression() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![instance_binding("a", vec!["x"], num(42.0))]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let exec_order = result.unwrap();
        assert_eq!(exec_order.len(), 1);
        assert_eq!(exec_order[0], "a");

        // Verify node properties
        let node = graph.get_node("a").unwrap();
        assert_eq!(node.instance_name, "a");
        assert!(matches!(node.node_type, NodeType::Expression));
        assert_eq!(node.outputs.len(), 1);
        assert!(node.deps.is_empty());
    }

    #[test]
    fn test_single_instance_builtin_call() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![instance_binding(
            "img",
            vec!["pixels"],
            call(
                "load",
                vec![ASTNode::Str(StrExpr {
                    v: "image.png".to_string(),
                })],
            ),
        )]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node = graph.get_node("img").unwrap();
        assert!(matches!(node.node_type, NodeType::Builtin));
    }

    #[test]
    fn test_single_instance_spindle_call() {
        let mut graph = RenderGraph::new();
        let env = test_env_with_spindle("blur");

        let prog = program(vec![instance_binding(
            "blurred",
            vec!["out"],
            call("blur", vec![num(5.0)]),
        )]);

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node = graph.get_node("blurred").unwrap();
        assert!(matches!(node.node_type, NodeType::Spindle));
    }

    #[test]
    fn test_simple_dependency_chain() {
        let mut graph = RenderGraph::new();
        // a = 5
        // b = a.x + 10
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            instance_binding(
                "b",
                vec!["y"],
                binary(strand_access("a", "x"), "+", num(10.0)),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let exec_order = result.unwrap();
        assert_eq!(exec_order.len(), 2);
        assert_eq!(exec_order[0], "a");
        assert_eq!(exec_order[1], "b");

        // Verify dependencies
        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.deps.is_empty());

        let node_b = graph.get_node("b").unwrap();
        assert_eq!(node_b.deps.len(), 1);
        assert!(node_b.deps.contains("a"));
    }

    #[test]
    fn test_multiple_dependencies() {
        let mut graph = RenderGraph::new();
        // a = 1
        // b = 2
        // c = a.x + b.y
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], num(2.0)),
            instance_binding(
                "c",
                vec!["z"],
                binary(strand_access("a", "x"), "+", strand_access("b", "y")),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let exec_order = result.unwrap();
        assert_eq!(exec_order.len(), 3);

        // c should be last
        assert_eq!(exec_order[2], "c");

        // a and b should be before c (order between them doesn't matter)
        assert!(exec_order[..2].contains(&"a".to_string()));
        assert!(exec_order[..2].contains(&"b".to_string()));

        let node_c = graph.get_node("c").unwrap();
        assert_eq!(node_c.deps.len(), 2);
        assert!(node_c.deps.contains("a"));
        assert!(node_c.deps.contains("b"));
    }

    #[test]
    fn test_dependency_in_call_args() {
        let mut graph = RenderGraph::new();
        // a = 5
        // b = func(a.x)
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            instance_binding(
                "b",
                vec!["out"],
                call("func", vec![strand_access("a", "x")]),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_b = graph.get_node("b").unwrap();
        assert!(node_b.deps.contains("a"));
    }

    #[test]
    fn test_dependency_in_strand_remap() {
        let mut graph = RenderGraph::new();
        // a = 5
        // b = 10
        // c = a@x[x: b.y]
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            instance_binding("b", vec!["y"], num(10.0)),
            instance_binding(
                "c",
                vec!["z"],
                strand_remap("a", "x", vec![(var("x"), strand_access("b", "y"))]),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_c = graph.get_node("c").unwrap();
        assert_eq!(node_c.deps.len(), 2);
        assert!(node_c.deps.contains("a"));
        assert!(node_c.deps.contains("b"));
    }

    #[test]
    fn test_circular_dependency_detected() {
        let mut graph = RenderGraph::new();
        // a = b.x
        // b = a.y
        let prog = program(vec![
            instance_binding("a", vec!["x"], strand_access("b", "x")),
            instance_binding("b", vec!["y"], strand_access("a", "y")),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_err());

        if let Err(WeftError::Runtime(msg)) = result {
            assert!(msg.contains("Circular dependency"));
        } else {
            panic!("Expected circular dependency error");
        }
    }

    #[test]
    fn test_self_dependency_detected() {
        let mut graph = RenderGraph::new();
        // a = a.x + 1
        let prog = program(vec![instance_binding(
            "a",
            vec!["x"],
            binary(strand_access("a", "x"), "+", num(1.0)),
        )]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_err());
    }

    #[test]
    fn test_complex_dependency_graph() {
        let mut graph = RenderGraph::new();
        // a = 1
        // b = 2
        // c = a.x + 3
        // d = b.y + c.z
        // e = c.z * 2
        // Expected order: a, b, c, d or e (d and e have no dependency on each other)
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], num(2.0)),
            instance_binding(
                "c",
                vec!["z"],
                binary(strand_access("a", "x"), "+", num(3.0)),
            ),
            instance_binding(
                "d",
                vec!["w"],
                binary(strand_access("b", "y"), "+", strand_access("c", "z")),
            ),
            instance_binding(
                "e",
                vec!["v"],
                binary(strand_access("c", "z"), "*", num(2.0)),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let exec_order = result.unwrap();
        assert_eq!(exec_order.len(), 5);

        // Find positions
        let pos = |name: &str| exec_order.iter().position(|x| x == name).unwrap();

        // Verify ordering constraints
        assert!(pos("a") < pos("c"));
        assert!(pos("b") < pos("d"));
        assert!(pos("c") < pos("d"));
        assert!(pos("c") < pos("e"));
    }

    #[test]
    fn test_tuple_outputs() {
        let mut graph = RenderGraph::new();
        // a<x, y> = <10, 20>
        let prog = program(vec![instance_binding(
            "a",
            vec!["x", "y"],
            tuple(vec![num(10.0), num(20.0)]),
        )]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node = graph.get_node("a").unwrap();
        assert_eq!(node.outputs.len(), 2);
        assert!(node.outputs.contains_key("x"));
        assert!(node.outputs.contains_key("y"));
    }

    #[test]
    fn test_context_tagging_visual() {
        let mut graph = RenderGraph::new();
        // a = 5
        // display(a.x)
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            backend("display", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.contexts.contains(&Context::Visual));
    }

    #[test]
    fn test_context_tagging_audio() {
        let mut graph = RenderGraph::new();
        // a = 440
        // play(a.freq)
        let prog = program(vec![
            instance_binding("a", vec!["freq"], num(440.0)),
            backend("play", vec![strand_access("a", "freq")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.contexts.contains(&Context::Audio));
    }

    #[test]
    fn test_context_propagation() {
        let mut graph = RenderGraph::new();
        // a = 1
        // b = a.x + 2
        // c = b.y + 3
        // display(c.z)
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding(
                "b",
                vec!["y"],
                binary(strand_access("a", "x"), "+", num(2.0)),
            ),
            instance_binding(
                "c",
                vec!["z"],
                binary(strand_access("b", "y"), "+", num(3.0)),
            ),
            backend("display", vec![strand_access("c", "z")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        assert!(graph
            .get_node("a")
            .unwrap()
            .contexts
            .contains(&Context::Visual));
        assert!(graph
            .get_node("b")
            .unwrap()
            .contexts
            .contains(&Context::Visual));
        assert!(graph
            .get_node("c")
            .unwrap()
            .contexts
            .contains(&Context::Visual));
    }

    #[test]
    fn test_multiple_contexts() {
        let mut graph = RenderGraph::new();
        // a = 5
        // display(a.x)
        // play(a.x)
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            backend("display", vec![strand_access("a", "x")]),
            backend("play", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.contexts.contains(&Context::Visual));
        assert!(node_a.contexts.contains(&Context::Audio));
        assert_eq!(node_a.contexts.len(), 2);
    }

    #[test]
    fn test_required_outputs_marking() {
        let mut graph = RenderGraph::new();
        // a<x, y> = (10, 20)
        // display(a.x)  // Only x is required
        let prog = program(vec![
            instance_binding("a", vec!["x", "y"], tuple(vec![num(10.0), num(20.0)])),
            backend("display", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert_eq!(node_a.required_outputs.len(), 1);
        assert!(node_a.required_outputs.contains("x"));
        assert!(!node_a.required_outputs.contains("y"));
    }

    #[test]
    fn test_required_outputs_in_strand_remap() {
        let mut graph = RenderGraph::new();
        // a<x, y> = <10, 20>
        // b<z> = a@x[...]
        // display(b@z)
        let prog = program(vec![
            instance_binding("a", vec!["x", "y"], tuple(vec![num(10.0), num(20.0)])),
            instance_binding("b", vec!["z"], strand_remap("a", "x", vec![])),
            backend("display", vec![strand_access("b", "z")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.required_outputs.contains("x"));
    }

    #[test]
    fn test_unknown_backend_error() {
        let mut graph = RenderGraph::new();
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(5.0)),
            backend("unknown_backend", vec![strand_access("a", "x")]),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_err());

        if let Err(WeftError::Runtime(msg)) = result {
            assert!(msg.contains("Unknown backend"));
        } else {
            panic!("Expected unknown backend error");
        }
    }

    #[test]
    fn test_nested_binary_expressions() {
        let mut graph = RenderGraph::new();
        // a = 1
        // b = 2
        // c = 3
        // d = (a.x + b.y) * c.z
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], num(2.0)),
            instance_binding("c", vec!["z"], num(3.0)),
            instance_binding(
                "d",
                vec!["w"],
                binary(
                    binary(strand_access("a", "x"), "+", strand_access("b", "y")),
                    "*",
                    strand_access("c", "z"),
                ),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_d = graph.get_node("d").unwrap();
        assert_eq!(node_d.deps.len(), 3);
        assert!(node_d.deps.contains("a"));
        assert!(node_d.deps.contains("b"));
        assert!(node_d.deps.contains("c"));
    }

    #[test]
    fn test_no_dependencies_on_literals() {
        let mut graph = RenderGraph::new();
        // a = 5 + 10
        let prog = program(vec![instance_binding(
            "a",
            vec!["x"],
            binary(num(5.0), "+", num(10.0)),
        )]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        assert!(node_a.deps.is_empty());
    }

    #[test]
    fn test_non_existent_dependency_ignored() {
        let mut graph = RenderGraph::new();
        // a = b.x  (b doesn't exist)
        let prog = program(vec![instance_binding(
            "a",
            vec!["x"],
            strand_access("b", "x"),
        )]);
        let env = test_env();

        // Should build successfully (dependency extraction finds "b" but edge building ignores it)
        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let node_a = graph.get_node("a").unwrap();
        // Deps will contain "b" but no edge will be created
        assert!(node_a.deps.contains("b"));
    }

    #[test]
    fn test_diamond_dependency() {
        let mut graph = RenderGraph::new();
        //     a
        //    / \
        //   b   c
        //    \ /
        //     d
        let prog = program(vec![
            instance_binding("a", vec!["x"], num(1.0)),
            instance_binding("b", vec!["y"], strand_access("a", "x")),
            instance_binding("c", vec!["z"], strand_access("a", "x")),
            instance_binding(
                "d",
                vec!["w"],
                binary(strand_access("b", "y"), "+", strand_access("c", "z")),
            ),
        ]);
        let env = test_env();

        let result = graph.build(&prog, &env);
        assert!(result.is_ok());

        let exec_order = result.unwrap();
        let pos = |name: &str| exec_order.iter().position(|x| x == name).unwrap();

        // a must come first
        assert_eq!(pos("a"), 0);
        // d must come last
        assert_eq!(pos("d"), 3);
        // b and c must be between a and d
        assert!(pos("b") > pos("a") && pos("b") < pos("d"));
        assert!(pos("c") > pos("a") && pos("c") < pos("d"));
    }
}

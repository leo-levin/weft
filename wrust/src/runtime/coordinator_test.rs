#[cfg(test)]
mod tests {
    use super::super::coordinator::Coordinator;
    use super::super::backend_registry::Context;
    use super::super::render_graph::Subgraph;
    use crate::backend::{Backend, DataRef};
    use crate::utils::Result;
    use crate::Env;
    use crate::WeftError;
    use std::collections::HashMap;

    // Mock CPU backend for testing
    struct MockCPUBackend {
        context: Context,
        values: HashMap<String, f64>,
    }

    impl MockCPUBackend {
        fn new(context: Context) -> Self {
            Self {
                context,
                values: HashMap::new(),
            }
        }
    }

    impl Backend for MockCPUBackend {
        fn context(&self) -> Context {
            self.context
        }

        fn supports_handles(&self) -> bool {
            false // CPU backend doesn't support GPU handles
        }

        fn compile_subgraph(
            &mut self,
            _subgraph: &Subgraph,
            _env: &Env,
            coordinator: &Coordinator,
        ) -> Result<()> {
            // Register some test outputs
            coordinator.expose("test_instance", "output1", self.context);
            coordinator.expose("test_instance", "output2", self.context);
            Ok(())
        }

        fn execute_subgraph(
            &mut self,
            _subgraph: &Subgraph,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<()> {
            // Mock execution
            Ok(())
        }

        fn get_value_at(
            &self,
            _instance: &str,
            _output: &str,
            coords: &HashMap<String, f64>,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<f64> {
            let x = coords.get("x").unwrap_or(&0.0);
            Ok(*x * 2.0) // Simple test computation
        }
    }

    // Mock GPU backend for testing
    struct MockGPUBackend {
        context: Context,
        handles: HashMap<String, u32>,
        next_handle: u32,
    }

    impl MockGPUBackend {
        fn new(context: Context) -> Self {
            Self {
                context,
                handles: HashMap::new(),
                next_handle: 1,
            }
        }
    }

    impl Backend for MockGPUBackend {
        fn context(&self) -> Context {
            self.context
        }

        fn supports_handles(&self) -> bool {
            true // GPU backend supports handles
        }

        fn compile_subgraph(
            &mut self,
            _subgraph: &Subgraph,
            _env: &Env,
            coordinator: &Coordinator,
        ) -> Result<()> {
            // Register GPU outputs
            coordinator.expose("gpu_instance", "texture", self.context);
            Ok(())
        }

        fn execute_subgraph(
            &mut self,
            _subgraph: &Subgraph,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<()> {
            Ok(())
        }

        fn get_value_at(
            &self,
            _instance: &str,
            _output: &str,
            _coords: &HashMap<String, f64>,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<f64> {
            Ok(0.5) // Fallback for GPU
        }

        fn get_handle(&self, instance: &str, output: &str) -> Result<u32> {
            let key = format!("{}@{}", instance, output);
            if key == "gpu_instance@texture" {
                Ok(42) // Mock GPU handle
            } else {
                Err(WeftError::Runtime("No handle available".to_string()))
            }
        }
    }

    #[test]
    fn test_expose_and_lookup_cpu_backend() {
        let mut coordinator = Coordinator::new();
        let backend = Box::new(MockCPUBackend::new(Context::Compute));

        coordinator.add_backend(backend);

        // Manually call expose (normally done during compile)
        coordinator.expose("test_instance", "output1", Context::Compute);

        // Test lookup - use immediately within coordinator's lifetime
        let data_ref = coordinator.lookup("test_instance", "output1");
        assert!(data_ref.is_ok(), "Lookup should succeed");

        // Use the DataRef immediately
        match data_ref.unwrap() {
            DataRef::ValueGetter(f) => {
                // Expected for CPU backend - test calling it
                let mut coords = HashMap::new();
                coords.insert("x".to_string(), 5.0);
                let env = Env::new(100, 100);
                let result = f(&coords, &env, &coordinator);
                assert!(result.is_ok(), "ValueGetter should work");
                assert_eq!(result.unwrap(), 10.0, "Should compute x * 2");
            }
            DataRef::Handle(_) => {
                panic!("CPU backend should not return a handle");
            }
        }; // Semicolon ensures temporary is dropped before coordinator
    }

    #[test]
    fn test_expose_and_lookup_gpu_backend() {
        let mut coordinator = Coordinator::new();
        let backend = Box::new(MockGPUBackend::new(Context::Visual));

        coordinator.add_backend(backend);

        // Manually call expose
        coordinator.expose("gpu_instance", "texture", Context::Visual);

        // Test lookup - should get a handle, use immediately
        match coordinator.lookup("gpu_instance", "texture").unwrap() {
            DataRef::Handle(handle) => {
                assert_eq!(handle, 42, "Should get the mock GPU handle");
            }
            DataRef::ValueGetter(_) => {
                panic!("GPU backend with handle support should return a handle");
            }
        }; // Semicolon ensures temporary is dropped before coordinator
    }

    #[test]
    fn test_lookup_nonexistent() {
        let coordinator = Coordinator::new();

        let result = coordinator.lookup("nonexistent", "output");
        assert!(result.is_err(), "Lookup of non-registered output should fail");
    }

    #[test]
    fn test_cpu_backend_skips_get_handle() {
        // This test verifies the efficiency optimization
        let mut coordinator = Coordinator::new();
        let backend = Box::new(MockCPUBackend::new(Context::Compute));

        coordinator.add_backend(backend);
        coordinator.expose("test", "output", Context::Compute);

        // If supports_handles() correctly returns false,
        // get_handle() should never be called
        match coordinator.lookup("test", "output").unwrap() {
            DataRef::ValueGetter(_) => {
                // Success - CPU backend uses ValueGetter without calling get_handle()
            }
            DataRef::Handle(_) => {
                panic!("CPU backend should not return a handle");
            }
        }; // Semicolon ensures temporary is dropped before coordinator
    }

    // Tracking backend that records compilation and execution order
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct ExecutionLog {
        compile_calls: Rc<RefCell<Vec<(Context, Vec<String>)>>>,
        execute_calls: Rc<RefCell<Vec<(Context, Vec<String>)>>>,
    }

    impl ExecutionLog {
        fn new() -> Self {
            Self {
                compile_calls: Rc::new(RefCell::new(Vec::new())),
                execute_calls: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn record_compile(&self, context: Context, nodes: Vec<String>) {
            self.compile_calls.borrow_mut().push((context, nodes));
        }

        fn record_execute(&self, context: Context, nodes: Vec<String>) {
            self.execute_calls.borrow_mut().push((context, nodes));
        }

        fn get_compile_calls(&self) -> Vec<(Context, Vec<String>)> {
            self.compile_calls.borrow().clone()
        }

        fn get_execute_calls(&self) -> Vec<(Context, Vec<String>)> {
            self.execute_calls.borrow().clone()
        }
    }

    struct TrackingBackend {
        context: Context,
        log: ExecutionLog,
    }

    impl TrackingBackend {
        fn new(context: Context, log: ExecutionLog) -> Self {
            Self { context, log }
        }
    }

    impl Backend for TrackingBackend {
        fn context(&self) -> Context {
            self.context
        }

        fn supports_handles(&self) -> bool {
            false
        }

        fn compile_subgraph(
            &mut self,
            subgraph: &Subgraph,
            _env: &Env,
            coordinator: &Coordinator,
        ) -> Result<()> {
            self.log.record_compile(self.context, subgraph.node_names.clone());

            // Expose all nodes in the subgraph
            for node_name in &subgraph.node_names {
                coordinator.expose(node_name, "out", self.context);
            }
            Ok(())
        }

        fn execute_subgraph(
            &mut self,
            subgraph: &Subgraph,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<()> {
            self.log.record_execute(self.context, subgraph.node_names.clone());
            Ok(())
        }

        fn get_value_at(
            &self,
            _instance: &str,
            _output: &str,
            _coords: &HashMap<String, f64>,
            _env: &Env,
            _coordinator: &Coordinator,
        ) -> Result<f64> {
            Ok(1.0)
        }
    }

    #[test]
    fn test_multiple_backends_work_together() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let audio_log = ExecutionLog::new();
        let visual_log = ExecutionLog::new();

        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Audio, audio_log.clone())));
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, visual_log.clone())));

        // Create a simple program with both contexts
        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "visual_node".to_string(),
                    outputs: vec!["color".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 1.0 })),
                }),
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio_node".to_string(),
                    outputs: vec!["freq".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 440.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual_node".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "color".to_string() })),
                    })],
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio_node".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        let result = coordinator.compile(&prog, &env);
        assert!(result.is_ok(), "Compile should succeed");

        // Both backends should have been called
        let audio_compiles = audio_log.get_compile_calls();
        let visual_compiles = visual_log.get_compile_calls();

        assert_eq!(audio_compiles.len(), 1, "Audio backend should compile 1 subgraph");
        assert_eq!(visual_compiles.len(), 1, "Visual backend should compile 1 subgraph");

        // Execute
        let result = coordinator.execute(&env);
        assert!(result.is_ok(), "Execute should succeed");

        let audio_executes = audio_log.get_execute_calls();
        let visual_executes = visual_log.get_execute_calls();

        assert_eq!(audio_executes.len(), 1, "Audio backend should execute 1 subgraph");
        assert_eq!(visual_executes.len(), 1, "Visual backend should execute 1 subgraph");
    }

    #[test]
    fn test_audio_visual_audio_chain_execution_order() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();

        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Audio, log.clone())));
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        // Create audio1 -> visual -> audio2 chain
        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio1".to_string(),
                    outputs: vec!["freq".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 440.0 })),
                }),
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "visual".to_string(),
                    outputs: vec!["color".to_string()],
                    expr: Box::new(ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio1".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })),
                }),
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio2".to_string(),
                    outputs: vec!["amp".to_string()],
                    expr: Box::new(ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "color".to_string() })),
                    })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio1".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })],
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "color".to_string() })),
                    })],
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio2".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "amp".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        let result = coordinator.compile(&prog, &env);
        assert!(result.is_ok(), "Compile should succeed");

        let compile_calls = log.get_compile_calls();

        // Should have 3 subgraphs total
        assert_eq!(compile_calls.len(), 3, "Should compile 3 subgraphs");

        // Execute
        let result = coordinator.execute(&env);
        assert!(result.is_ok(), "Execute should succeed");

        let execute_calls = log.get_execute_calls();
        assert_eq!(execute_calls.len(), 3, "Should execute 3 subgraphs");

        // Verify execution order: audio1 must come before visual, visual before audio2
        let audio1_pos = execute_calls.iter().position(|(_, nodes)| nodes.contains(&"audio1".to_string()));
        let visual_pos = execute_calls.iter().position(|(_, nodes)| nodes.contains(&"visual".to_string()));
        let audio2_pos = execute_calls.iter().position(|(_, nodes)| nodes.contains(&"audio2".to_string()));

        assert!(audio1_pos.is_some(), "audio1 should be executed");
        assert!(visual_pos.is_some(), "visual should be executed");
        assert!(audio2_pos.is_some(), "audio2 should be executed");

        assert!(audio1_pos < visual_pos, "audio1 must execute before visual");
        assert!(visual_pos < audio2_pos, "visual must execute before audio2");
    }

    #[test]
    fn test_missing_backend_error() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();
        // Only add Audio backend, not Visual

        coordinator.add_backend(Box::new(MockCPUBackend::new(Context::Audio)));

        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "visual_node".to_string(),
                    outputs: vec!["color".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 1.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual_node".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "color".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        let result = coordinator.compile(&prog, &env);

        assert!(result.is_err(), "Compile should fail when backend is missing");
        if let Err(e) = result {
            let error_msg = format!("{:?}", e);
            assert!(error_msg.contains("No backend registered"), "Error should mention missing backend");
        }
    }

    #[test]
    fn test_execute_before_compile_fails() {
        let coordinator = Coordinator::new();
        let env = Env::new(100, 100);

        let result = coordinator.execute(&env);
        assert!(result.is_err(), "Execute should fail before compile");

        if let Err(e) = result {
            let error_msg = format!("{:?}", e);
            assert!(error_msg.contains("Must call compile()"), "Error should mention compile");
        }
    }

    #[test]
    fn test_multiple_subgraphs_same_backend() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Audio, log.clone())));
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        // Create two independent audio subgraphs
        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio1".to_string(),
                    outputs: vec!["freq".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 440.0 })),
                }),
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio2".to_string(),
                    outputs: vec!["freq".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 880.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio1".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })],
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio2".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        let result = coordinator.compile(&prog, &env);
        assert!(result.is_ok(), "Compile should succeed");

        let compile_calls = log.get_compile_calls();

        // Should have 2 separate Audio subgraphs
        let audio_compiles: Vec<_> = compile_calls.iter()
            .filter(|(ctx, _)| *ctx == Context::Audio)
            .collect();

        assert_eq!(audio_compiles.len(), 2, "Should compile 2 separate Audio subgraphs");

        // Execute
        let result = coordinator.execute(&env);
        assert!(result.is_ok(), "Execute should succeed");

        let execute_calls = log.get_execute_calls();
        let audio_executes: Vec<_> = execute_calls.iter()
            .filter(|(ctx, _)| *ctx == Context::Audio)
            .collect();

        assert_eq!(audio_executes.len(), 2, "Should execute 2 separate Audio subgraphs");
    }

    #[test]
    fn test_expose_during_compile() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "node1".to_string(),
                    outputs: vec!["output1".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 1.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "node1".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "output1".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        coordinator.compile(&prog, &env).unwrap();

        // TrackingBackend exposes all nodes, so lookup should succeed
        let result = coordinator.lookup("node1", "out");
        assert!(result.is_ok(), "Lookup should succeed after compile exposes outputs");
    }

    #[test]
    fn test_lookup_cross_context() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Audio, log.clone())));
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        // Create cross-context reference: audio depends on visual
        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "visual_source".to_string(),
                    outputs: vec!["brightness".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 0.5 })),
                }),
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "audio_out".to_string(),
                    outputs: vec!["freq".to_string()],
                    expr: Box::new(ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual_source".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "brightness".to_string() })),
                    })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "visual_source".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "brightness".to_string() })),
                    })],
                }),
                ASTNode::Backend(BackendExpr {
                    context: "play".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "audio_out".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "freq".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        coordinator.compile(&prog, &env).unwrap();

        // Both outputs should be exposed and accessible
        assert!(coordinator.lookup("visual_source", "out").is_ok(), "Visual output should be exposed");
        assert!(coordinator.lookup("audio_out", "out").is_ok(), "Audio output should be exposed");
    }

    #[test]
    fn test_lookup_returns_value_getter() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "test_node".to_string(),
                    outputs: vec!["value".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 42.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "test_node".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "value".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        coordinator.compile(&prog, &env).unwrap();

        // Lookup should return a ValueGetter for CPU backend
        match coordinator.lookup("test_node", "out").unwrap() {
            DataRef::ValueGetter(getter) => {
                // Call the getter to verify it works
                let coords = HashMap::new();
                let result = getter(&coords, &env, &coordinator);
                assert!(result.is_ok(), "ValueGetter should return a value");
                assert_eq!(result.unwrap(), 1.0, "TrackingBackend returns 1.0");
            }
            DataRef::Handle(_) => {
                panic!("TrackingBackend should return ValueGetter, not Handle");
            }
        }; // Semicolon ensures temporary is dropped before coordinator
    }

    #[test]
    fn test_lookup_fails_for_uncompiled_node() {
        use crate::ast::*;

        let mut coordinator = Coordinator::new();

        let log = ExecutionLog::new();
        coordinator.add_backend(Box::new(TrackingBackend::new(Context::Visual, log.clone())));

        // Compile with one node
        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "node1".to_string(),
                    outputs: vec!["out1".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 1.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "node1".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "out1".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        coordinator.compile(&prog, &env).unwrap();

        // Lookup for a node that wasn't compiled should fail
        let result = coordinator.lookup("nonexistent_node", "out");
        assert!(result.is_err(), "Lookup for uncompiled node should fail");
    }

    #[test]
    fn test_multiple_outputs_same_node() {
        use crate::ast::*;

        struct MultiOutputBackend {
            context: Context,
        }

        impl Backend for MultiOutputBackend {
            fn context(&self) -> Context {
                self.context
            }

            fn supports_handles(&self) -> bool {
                false
            }

            fn compile_subgraph(
                &mut self,
                subgraph: &Subgraph,
                _env: &Env,
                coordinator: &Coordinator,
            ) -> Result<()> {
                // Expose multiple outputs for each node
                for node_name in &subgraph.node_names {
                    coordinator.expose(node_name, "output1", self.context);
                    coordinator.expose(node_name, "output2", self.context);
                    coordinator.expose(node_name, "output3", self.context);
                }
                Ok(())
            }

            fn execute_subgraph(
                &mut self,
                _subgraph: &Subgraph,
                _env: &Env,
                _coordinator: &Coordinator,
            ) -> Result<()> {
                Ok(())
            }

            fn get_value_at(
                &self,
                _instance: &str,
                output: &str,
                _coords: &HashMap<String, f64>,
                _env: &Env,
                _coordinator: &Coordinator,
            ) -> Result<f64> {
                // Return different values for different outputs
                match output {
                    "output1" => Ok(1.0),
                    "output2" => Ok(2.0),
                    "output3" => Ok(3.0),
                    _ => Ok(0.0),
                }
            }
        }

        let mut coordinator = Coordinator::new();
        coordinator.add_backend(Box::new(MultiOutputBackend { context: Context::Visual }));

        let prog = Program {
            statements: vec![
                ASTNode::InstanceBinding(InstanceBindExpr {
                    name: "multi_node".to_string(),
                    outputs: vec!["a".to_string(), "b".to_string(), "c".to_string()],
                    expr: Box::new(ASTNode::Num(NumExpr { v: 1.0 })),
                }),
                ASTNode::Backend(BackendExpr {
                    context: "display".to_string(),
                    args: vec![],
                    named_args: HashMap::new(),
                    positional_args: vec![ASTNode::StrandAccess(StrandAccessExpr {
                        base: Box::new(ASTNode::Var(VarExpr { name: "multi_node".to_string() })),
                        out: Box::new(ASTNode::Var(VarExpr { name: "a".to_string() })),
                    })],
                }),
            ],
        };

        let env = Env::new(100, 100);
        coordinator.compile(&prog, &env).unwrap();

        // All three outputs should be exposed
        assert!(coordinator.lookup("multi_node", "output1").is_ok(), "output1 should be exposed");
        assert!(coordinator.lookup("multi_node", "output2").is_ok(), "output2 should be exposed");
        assert!(coordinator.lookup("multi_node", "output3").is_ok(), "output3 sIhould be exposed");

        // Verify different values are returned
        let coords = HashMap::new();

        if let DataRef::ValueGetter(getter) = coordinator.lookup("multi_node", "output1").unwrap() {
            assert_eq!(getter(&coords, &env, &coordinator).unwrap(), 1.0);
        };

        if let DataRef::ValueGetter(getter) = coordinator.lookup("multi_node", "output2").unwrap() {
            assert_eq!(getter(&coords, &env, &coordinator).unwrap(), 2.0);
        };

        if let DataRef::ValueGetter(getter) = coordinator.lookup("multi_node", "output3").unwrap() {
            assert_eq!(getter(&coords, &env, &coordinator).unwrap(), 3.0);
        };
    }
}

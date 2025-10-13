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
}

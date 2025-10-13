use crate::runtime::backend_registry::Context;
use crate::runtime::render_graph::Subgraph;
use crate::runtime::Coordinator;
use crate::Env;
use crate::utils::Result;
use crate::WeftError;
use std::collections::HashMap;

pub type HandleType = u32;

pub enum DataRef<'a> {
    ValueGetter(Box<dyn Fn(&HashMap<String, f64>, &Env, &Coordinator) -> Result<f64> + 'a>),
    Handle(HandleType),
}

pub trait Backend {
    fn context(&self) -> Context;

    fn supports_handles(&self) -> bool {
        false
    }

    fn compile_subgraph(
        &mut self,
        subgraph: &Subgraph,
        env: &Env,
        coordinator: &Coordinator,
    ) -> Result<()>;

    fn execute_subgraph(
        &mut self,
        subgraph: &Subgraph,
        env: &Env,
        coordinator: &Coordinator,
    ) -> Result<()>;

    fn get_value_at(
        &self,
        instance: &str,
        output: &str,
        coords: &HashMap<String, f64>,
        env: &Env,
        coordinator: &Coordinator,
    ) -> Result<f64>;

    fn get_handle(&self, instance: &str, output: &str) -> Result<HandleType> {
        Err(WeftError::Runtime(format!(
            "Backend {} does not support handles for {}@{}",
            self.context().name(),
            instance,
            output
        )))
    }
}
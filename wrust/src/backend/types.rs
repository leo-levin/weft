use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use crate::runtime::render_graph::GraphNode;
use crate::runtime::Env;
use crate::utils::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleType {
    Buffer,
    Texture,
    Sampler,
}

#[derive(Clone)]
pub struct OutputHandle {
    inner: Arc<dyn Any + Send + Sync>,
    handle_type: HandleType,
}

impl OutputHandle {
    pub fn new<T: Any + Send + Sync>(value: T, handle_type: HandleType) -> Self {
        Self {
            inner: Arc::new(value),
            handle_type,
        }
    }

    pub fn handle_type(&self) -> HandleType {
        self.handle_type
    }

    pub fn downcast<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.inner.clone().downcast::<T>().ok()
    }

    pub fn into_any(self) -> Arc<dyn Any + Send + Sync> {
        self.inner
    }
}

#[derive(Clone)]
pub enum DataReference {
    MetalBuffer(Arc<dyn Any + Send + Sync>),
    MetalTexture(Arc<dyn Any + Send + Sync>),

    ValueGetter(Arc<dyn Fn(&HashMap<String, f64>) -> f64 + Send + Sync>),
}
pub trait Backend: Send {
    fn context(&self) -> &str;
    fn compile_nodes(
        &mut self,
        nodes: &[&GraphNode],
        env: &Env,
        coordinator: &crate::runtime::Coordinator,
    ) -> Result<()>;

    fn get_handle(&self, _instance: &str, _output: &str) -> Result<OutputHandle> {
        Err(crate::utils::WeftError::Runtime(
            "Backend does not support handle access".into(),
        ))
    }

    fn get_value_at(
        &self,
        _instance: &str,
        _output: &str,
        _coords: &HashMap<String, f64>,
    ) -> Result<f64> {
        Err(crate::utils::WeftError::Runtime(
            "Backend does not support value access".into(),
        ))
    }
    fn execute(&mut self, env: &Env) -> Result<()>;

    fn cleanup(&mut self) {}
}

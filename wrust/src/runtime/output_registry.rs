use std::collections::HashMap;

use crate::backend::OutputHandle;
use crate::utils::Result;

#[derive(Clone)]
pub struct OutputLocation {
    pub instance: String,
    pub output: String,
    pub backend_index: usize,
    pub handle: OutputHandle,
}

pub struct OutputRegistry {
    outputs: HashMap<String, OutputLocation>,
}

impl OutputRegistry {
    pub fn new() -> Self {
        Self {
            outputs: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        instance: &str,
        output: &str,
        handle: OutputHandle,
        backend_index: usize,
    ) {
        let key = format!("{}.{}", instance, output);
        self.outputs.insert(
            key,
            OutputLocation {
                instance: instance.to_string(),
                output: output.to_string(),
                backend_index,
                handle,
            },
        );
    }

    pub fn get(&self, instance: &str, output: &str) -> Result<&OutputLocation> {
        let key = format!("{}.{}", instance, output);
        self.outputs.get(&key).ok_or_else(|| {
            crate::utils::WeftError::Runtime(format!("Output not found: {}.{}", instance, output))
        })
    }

    pub fn contains(&self, instance: &str, output: &str) -> bool {
        let key = format!("{}.{}", instance, output);
        self.outputs.contains_key(&key)
    }

    pub fn all_outputs(&self) -> Vec<(&str, &str, usize)> {
        self.outputs
            .values()
            .map(|loc| (loc.instance.as_str(), loc.output.as_str(), loc.backend_index))
            .collect()
    }
}

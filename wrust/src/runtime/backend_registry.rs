/// Represents the execution context for a rendering backend
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Context {
    Visual,
    Audio,
    Compute,
}

pub fn get_context(backend_keyword: &str) -> Option<Context> {
    match backend_keyword {
        "display" | "render" | "render_3d" => Some(Context::Visual),
        "play" => Some(Context::Audio),
        "compute" | "data" | "web" | "osc" | "midi" => Some(Context::Compute),
        _ => None,
    }
}

pub fn is_valid_backend(keyword: &str) -> bool {
    get_context(keyword).is_some()
}

impl Context {
    pub fn name(&self) -> &str {
        match self {
            Context::Visual => "Visual",
            Context::Audio => "Audio",
            Context::Compute => "Compute",
        }
    }
    pub fn priority(&self) -> u32 {
        match self {
            Context::Visual => 0, // Highest priority
            Context::Audio => 1,
            Context::Compute => 2, // Lowest priority
        }
    }
}

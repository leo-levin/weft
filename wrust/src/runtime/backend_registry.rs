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

use super::backend_registry::Context;

pub fn get_builtin_context(builtin_name: &str) -> Option<Context> {
    match builtin_name {
        "load_movie" | "load_video" | "load_image" | "camera" | "camera_in" => {
            Some(Context::Visual)
        }

        "load_audio" | "mic_in" | "microphone" => Some(Context::Audio),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_visual_builtins() {
        assert_eq!(get_builtin_context("load_movie"), Some(Context::Visual));
        assert_eq!(get_builtin_context("camera"), Some(Context::Visual));
        assert_eq!(get_builtin_context("load_image"), Some(Context::Visual));
    }

    #[test]
    fn test_audio_builtins() {
        assert_eq!(get_builtin_context("load_audio"), Some(Context::Audio));
        assert_eq!(get_builtin_context("mic_in"), Some(Context::Audio));
    }

    #[test]
    fn test_context_agnostic_builtins() {
        assert_eq!(get_builtin_context("mouse_in"), None);
        assert_eq!(get_builtin_context("keyboard_in"), None);
    }

    #[test]
    fn test_unknown_builtin() {
        assert_eq!(get_builtin_context("unknown_function"), None);
    }
}

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

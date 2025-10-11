use thiserror::Error;

pub type Result<T> = std::result::Result<T, WeftError>;

#[derive(Debug, Error)]
pub enum WeftError {
    #[error("Parse error: {0}")]
    Parse(String),

    #[error("{0}")]
    Runtime(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

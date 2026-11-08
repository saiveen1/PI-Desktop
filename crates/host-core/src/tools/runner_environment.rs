//! Subprocess-only environment shared by the hidden runner and libtest shell path.
use super::ToolRunnerStartConfig;
use tokio::process::Command;

pub(super) fn apply(command: &mut Command, config: &ToolRunnerStartConfig) {
    // Python's redirected Windows streams otherwise use the ANSI code page,
    // which cannot represent all tool output. Do not change file encodings or
    // replace an inherited preference; explicit command configuration wins below.
    #[cfg(windows)]
    if std::env::var_os("PYTHONIOENCODING").is_none() {
        command.env("PYTHONIOENCODING", "utf-8");
    }
    if let Some(scratch_dir) = config.scratch_dir.as_deref() {
        command.env("PI_SCRATCH_DIR", scratch_dir);
    }
    if let Some(path) = config.env_path.as_deref() {
        command.env("PATH", path);
    }
    for (name, value) in &config.extra_env {
        command.env(name, value);
    }
}

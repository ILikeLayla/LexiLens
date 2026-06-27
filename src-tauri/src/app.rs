use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) fn app_state_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    session::app_state_file_path(&app_data_dir)
}

pub(crate) fn app_config_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    session::app_config_file_path(&app_data_dir)
}

pub(crate) fn resolve_active_file_path(
    session_path: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    let trimmed_name = file_name.trim();
    if trimmed_name.is_empty() {
        return Err("Active file name cannot be empty".to_string());
    }

    let relative_path = Path::new(trimmed_name);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(
            "Active file name must be a relative file inside the selected session".to_string(),
        );
    }

    let file_path = Path::new(session_path).join(relative_path);
    if !file_path.exists() {
        return Err(format!(
            "Active file does not exist: {}",
            file_path.display()
        ));
    }

    Ok(file_path)
}

pub(crate) fn provider_requires_api_key(provider: &str) -> bool {
    !provider.trim().to_ascii_lowercase().contains("local")
}

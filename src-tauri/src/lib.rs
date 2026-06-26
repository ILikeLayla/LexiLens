use tauri::{AppHandle, Manager};
use session::{FolderSession, PersistedAppState};

fn app_state_file_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    session::app_state_file_path(&app_data_dir)
}

#[tauri::command]
fn read_folder_session(path: String) -> Result<FolderSession, String> {
    session::read_folder_session(&path)
}

#[tauri::command]
fn load_app_state(app_handle: AppHandle) -> Result<Option<PersistedAppState>, String> {
    let state_file_path = app_state_file_path(&app_handle)?;
    session::load_app_state(&state_file_path)
}

#[tauri::command]
fn save_app_state(app_handle: AppHandle, state: PersistedAppState) -> Result<(), String> {
    let state_file_path = app_state_file_path(&app_handle)?;
    session::save_app_state(&state_file_path, &state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_folder_session, load_app_state, save_app_state])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

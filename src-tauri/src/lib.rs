use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    id: String,
    name: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSession {
    id: String,
    title: String,
    updated_at: String,
    path: String,
    files: Vec<SessionFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAppState {
    session_collapsed: bool,
    files_collapsed: bool,
    active_session: String,
    active_file: String,
    sessions: Vec<PersistedSessionItem>,
    files_by_session: std::collections::HashMap<String, Vec<SessionFile>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionItem {
    id: String,
    title: String,
    updated_at: String,
    path: String,
}

fn app_state_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    let state_dir = app_data_dir.join("LexiLens").join("state");
    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Failed to create state directory: {error}"))?;

    Ok(state_dir.join("app-state.json"))
}

#[tauri::command]
fn read_folder_session(path: String) -> Result<FolderSession, String> {
    let directory_path = Path::new(&path);
    if !directory_path.exists() {
        return Err("Selected folder does not exist".to_string());
    }
    if !directory_path.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }

    let title = directory_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Session Folder")
        .to_string();

    let mut files = Vec::new();
    let entries = std::fs::read_dir(directory_path)
        .map_err(|error| format!("Failed to read folder: {error}"))?;

    for (index, entry_result) in entries.enumerate() {
        let entry = entry_result.map_err(|error| format!("Failed to read an entry: {error}"))?;
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }

        let name = entry
            .file_name()
            .to_str()
            .map_or_else(|| "unknown".to_string(), |value| value.to_string());

        let status = match entry_path.extension().and_then(|ext| ext.to_str()) {
            Some("md") | Some("txt") | Some("json") => "processed",
            Some("pdf") | Some("docx") | Some("png") | Some("jpg") | Some("jpeg") => "raw",
            _ => "draft",
        }
        .to_string();

        files.push(SessionFile {
            id: format!("{}-{index}", sanitize_id(&path)),
            name,
            status,
        });
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(FolderSession {
        id: sanitize_id(&path),
        title,
        updated_at: "Just now".to_string(),
        path,
        files,
    })
}

#[tauri::command]
fn load_app_state(app_handle: AppHandle) -> Result<Option<PersistedAppState>, String> {
    let state_file_path = app_state_file_path(&app_handle)?;
    if !state_file_path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&state_file_path)
        .map_err(|error| format!("Failed to read saved app state: {error}"))?;

    let state = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse saved app state: {error}"))?;

    Ok(Some(state))
}

#[tauri::command]
fn save_app_state(app_handle: AppHandle, state: PersistedAppState) -> Result<(), String> {
    let state_file_path = app_state_file_path(&app_handle)?;
    let contents = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("Failed to serialize app state: {error}"))?;

    fs::write(&state_file_path, contents)
        .map_err(|error| format!("Failed to write app state file: {error}"))
}

fn sanitize_id(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
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

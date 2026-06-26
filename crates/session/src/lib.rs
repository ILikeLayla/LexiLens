use domain::{LexiLensError, SessionRecord, SessionStore};
use serde::{Deserialize, Serialize};
use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
};

#[derive(Default)]
pub struct InMemorySessionStore {
  sessions: Vec<SessionRecord>,
}

impl SessionStore for InMemorySessionStore {
  fn save(&mut self, record: SessionRecord) -> Result<(), LexiLensError> {
    self.sessions.push(record);
    Ok(())
  }

  fn load_all(&self) -> Result<Vec<SessionRecord>, LexiLensError> {
    Ok(self.sessions.clone())
  }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
  pub id: String,
  pub name: String,
  pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSession {
  pub id: String,
  pub title: String,
  pub updated_at: String,
  pub path: String,
  pub files: Vec<SessionFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAppState {
  pub session_collapsed: bool,
  pub files_collapsed: bool,
  pub active_session: String,
  pub active_file: String,
  pub sessions: Vec<PersistedSessionItem>,
  pub files_by_session: HashMap<String, Vec<SessionFile>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionItem {
  pub id: String,
  pub title: String,
  pub updated_at: String,
  pub path: String,
}

pub fn app_state_file_path(app_data_dir: &Path) -> Result<PathBuf, String> {
  let state_dir = app_data_dir.join("LexiLens").join("state");
  fs::create_dir_all(&state_dir).map_err(|error| format!("Failed to create state directory: {error}"))?;

  Ok(state_dir.join("app-state.json"))
}

pub fn read_folder_session(path: &str) -> Result<FolderSession, String> {
  let directory_path = Path::new(path);
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
  let entries = fs::read_dir(directory_path).map_err(|error| format!("Failed to read folder: {error}"))?;

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
      id: format!("{}-{index}", sanitize_id(path)),
      name,
      status,
    });
  }

  files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

  Ok(FolderSession {
    id: sanitize_id(path),
    title,
    updated_at: "Just now".to_string(),
    path: path.to_string(),
    files,
  })
}

pub fn load_app_state(state_file_path: &Path) -> Result<Option<PersistedAppState>, String> {
  if !state_file_path.exists() {
    return Ok(None);
  }

  let contents = fs::read_to_string(state_file_path).map_err(|error| format!("Failed to read saved app state: {error}"))?;

  let state = serde_json::from_str(&contents).map_err(|error| format!("Failed to parse saved app state: {error}"))?;

  Ok(Some(state))
}

pub fn save_app_state(state_file_path: &Path, state: &PersistedAppState) -> Result<(), String> {
  let contents = serde_json::to_string_pretty(state).map_err(|error| format!("Failed to serialize app state: {error}"))?;

  fs::write(state_file_path, contents).map_err(|error| format!("Failed to write app state file: {error}"))
}

fn sanitize_id(path: &str) -> String {
  path
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() {
        character.to_ascii_lowercase()
      } else {
        '-'
      }
    })
    .collect()
}

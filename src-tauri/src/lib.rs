mod app;
mod chat;
mod tts;

use session::{FolderSession, PersistedAppConfig, PersistedAppState};
use tauri::AppHandle;

use chat::{ChatRequest, ChatResponse};
use tts::SynthesizedSpeech;

#[tauri::command]
fn read_folder_session(path: String) -> Result<FolderSession, String> {
    session::read_folder_session(&path)
}

#[tauri::command]
fn load_app_state(app_handle: AppHandle) -> Result<Option<PersistedAppState>, String> {
    let state_file_path = app::app_state_file_path(&app_handle)?;
    session::load_app_state(&state_file_path)
}

#[tauri::command]
fn save_app_state(app_handle: AppHandle, state: PersistedAppState) -> Result<(), String> {
    let state_file_path = app::app_state_file_path(&app_handle)?;
    session::save_app_state(&state_file_path, &state)
}

#[tauri::command]
fn load_app_config(app_handle: AppHandle) -> Result<PersistedAppConfig, String> {
    let config_file_path = app::app_config_file_path(&app_handle)?;
    session::load_app_config(&config_file_path)
}

#[tauri::command]
fn save_app_config(app_handle: AppHandle, config: PersistedAppConfig) -> Result<(), String> {
    let config_file_path = app::app_config_file_path(&app_handle)?;
    session::save_app_config(&config_file_path, &config)
}

#[tauri::command]
async fn render_active_file(
    session_path: String,
    file_name: String,
) -> Result<render::RenderedDocument, String> {
    let file_path = app::resolve_active_file_path(&session_path, &file_name)?;

    tauri::async_runtime::spawn_blocking(move || render::render_document(&file_path))
        .await
        .map_err(|error| format!("Failed to join render task: {error}"))?
}
#[tauri::command]
async fn preprocess_tts_text(app_handle: AppHandle, text: String) -> Result<String, String> {
    let config_file_path = app::app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;
    chat::preprocess_tts_text(&config, &text).await
}

#[tauri::command]
async fn synthesize_speech(
    app_handle: AppHandle,
    text: String,
) -> Result<Option<SynthesizedSpeech>, String> {
    let config_file_path = app::app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;
    tts::synthesize_with_config(&config, &text).await
}

#[tauri::command]
async fn chat_with_context(
    app_handle: AppHandle,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    if request.user_message.trim().is_empty() {
        return Err("Message cannot be empty".to_string());
    }

    let config_file_path = app::app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;
    let provider = config.provider.trim().to_ascii_lowercase();

    if app::provider_requires_api_key(&provider) && config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let answer_text = if provider == "openai-compatible" {
        chat::call_openai_compatible_chat(&config, &request).await?
    } else if provider.contains("local") {
        format!(
            "Local provider is configured, but no local model runtime is connected yet.\n\nContext:\n- Session: {}\n- File: {}\n\nRequest:\n{}",
            request.session_title.unwrap_or_else(|| "(none)".to_string()),
            request.active_file_name.unwrap_or_else(|| "(none)".to_string()),
            request.user_message
        )
    } else {
        return Err(format!(
            "Unsupported provider '{}'. Use 'openai-compatible' or 'local'.",
            config.provider
        ));
    };

    Ok(ChatResponse {
        provider: config.provider,
        model: config.model,
        text: answer_text,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_file_path = app::app_config_file_path(&app.handle())?;
            session::ensure_app_config(&config_file_path).map_err(std::io::Error::other)?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_folder_session,
            load_app_state,
            save_app_state,
            load_app_config,
            save_app_config,
            render_active_file,
            chat_with_context,
            preprocess_tts_text,
            synthesize_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

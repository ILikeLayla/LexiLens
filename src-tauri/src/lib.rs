use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use session::{FolderSession, PersistedAppConfig, PersistedAppState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    user_message: String,
    session_title: Option<String>,
    session_path: Option<String>,
    active_file_name: Option<String>,
    active_file_status: Option<String>,
    recent_messages: Vec<ChatMessageInput>,
}

#[derive(Deserialize)]
struct ChatMessageInput {
    role: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatResponse {
    provider: String,
    model: String,
    text: String,
}

#[derive(Serialize)]
struct OpenAiCompatibleMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct OpenAiCompatibleChatRequest {
    model: String,
    messages: Vec<OpenAiCompatibleMessage>,
    temperature: f32,
}

#[derive(Deserialize)]
struct OpenAiCompatibleChatResponse {
    choices: Vec<OpenAiCompatibleChoice>,
}

#[derive(Deserialize)]
struct OpenAiCompatibleChoice {
    message: OpenAiCompatibleChoiceMessage,
}

#[derive(Deserialize)]
struct OpenAiCompatibleChoiceMessage {
    content: serde_json::Value,
}

fn app_state_file_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    session::app_state_file_path(&app_data_dir)
}

fn app_config_file_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    session::app_config_file_path(&app_data_dir)
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

#[tauri::command]
fn load_app_config(app_handle: AppHandle) -> Result<PersistedAppConfig, String> {
    let config_file_path = app_config_file_path(&app_handle)?;
    session::load_app_config(&config_file_path)
}

#[tauri::command]
fn save_app_config(app_handle: AppHandle, config: PersistedAppConfig) -> Result<(), String> {
    let config_file_path = app_config_file_path(&app_handle)?;
    session::save_app_config(&config_file_path, &config)
}

fn provider_requires_api_key(provider: &str) -> bool {
    !provider.trim().to_ascii_lowercase().contains("local")
}

fn extract_response_text(content: serde_json::Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let parts = content.as_array()?;
    let mut merged = String::new();
    for part in parts {
        if let Some(text_value) = part.get("text").and_then(|value| value.as_str()) {
            if !merged.is_empty() {
                merged.push('\n');
            }
            merged.push_str(text_value);
        }
    }

    if merged.trim().is_empty() {
        None
    } else {
        Some(merged)
    }
}

async fn call_openai_compatible_chat(config: &PersistedAppConfig, request: &ChatRequest) -> Result<String, String> {
    let mut base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Missing baseUrl for openai-compatible provider".to_string());
    }
    if !base_url.ends_with("/chat/completions") {
        base_url.push_str("/chat/completions");
    }

    let session_title = request.session_title.as_deref().unwrap_or("(none)");
    let session_path = request.session_path.as_deref().unwrap_or("(none)");
    let file_name = request.active_file_name.as_deref().unwrap_or("(none)");
    let file_status = request.active_file_status.as_deref().unwrap_or("(none)");

    let mut messages = vec![OpenAiCompatibleMessage {
        role: "system".to_string(),
        content: "You are LexiLens, a reading and rewriting assistant. Use provided session/file context to answer precisely and keep responses concise and helpful.".to_string(),
    }];

    for message in request.recent_messages.iter().rev().take(8).rev() {
        let normalized_role = match message.role.as_str() {
            "assistant" | "user" | "system" => message.role.clone(),
            _ => "user".to_string(),
        };
        messages.push(OpenAiCompatibleMessage {
            role: normalized_role,
            content: message.text.clone(),
        });
    }

    let contextual_user_prompt = format!(
        "Session title: {session_title}\nSession path: {session_path}\nActive file: {file_name}\nActive file status: {file_status}\n\nUser request:\n{}",
        request.user_message
    );

    messages.push(OpenAiCompatibleMessage {
        role: "user".to_string(),
        content: contextual_user_prompt,
    });

    let response = reqwest::Client::new()
        .post(base_url)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {}", config.api_key.trim()))
        .json(&OpenAiCompatibleChatRequest {
            model: config.model.clone(),
            messages,
            temperature: 0.3,
        })
        .send()
        .await
        .map_err(|error| format!("Failed to call provider API: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable error body>".to_string());
        return Err(format!("Provider API returned {status}: {body}"));
    }

    let parsed_response: OpenAiCompatibleChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse provider response: {error}"))?;

    let first_choice = parsed_response
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "Provider response did not contain choices".to_string())?;

    extract_response_text(first_choice.message.content)
        .ok_or_else(|| "Provider response did not contain readable text content".to_string())
}

#[tauri::command]
async fn chat_with_context(app_handle: AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    if request.user_message.trim().is_empty() {
        return Err("Message cannot be empty".to_string());
    }

    let config_file_path = app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;
    let provider = config.provider.trim().to_ascii_lowercase();

    if provider_requires_api_key(&provider) && config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let answer_text = if provider == "openai-compatible" {
        call_openai_compatible_chat(&config, &request).await?
    } else if provider.contains("local") {
        format!(
            "Local provider is configured, but no local model runtime is connected yet.\n\nContext:\n- Session: {}\n- File: {}\n\nRequest:\n{}",
            request.session_title.unwrap_or_else(|| "(none)".to_string()),
            request.active_file_name.unwrap_or_else(|| "(none)".to_string()),
            request.user_message
        )
    } else {
        return Err(format!("Unsupported provider '{}'. Use 'openai-compatible' or 'local'.", config.provider));
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
            let config_file_path = app_config_file_path(&app.handle())?;
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
            chat_with_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

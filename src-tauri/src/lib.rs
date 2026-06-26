use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
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

fn resolve_active_file_path(session_path: &str, file_name: &str) -> Result<std::path::PathBuf, String> {
    let trimmed_name = file_name.trim();
    if trimmed_name.is_empty() {
        return Err("Active file name cannot be empty".to_string());
    }

    let relative_path = Path::new(trimmed_name);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("Active file name must be a relative file inside the selected session".to_string());
    }

    let file_path = Path::new(session_path).join(relative_path);
    if !file_path.exists() {
        return Err(format!("Active file does not exist: {}", file_path.display()));
    }

    Ok(file_path)
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

#[tauri::command]
async fn render_active_file(session_path: String, file_name: String) -> Result<render::RenderedDocument, String> {
    let file_path = resolve_active_file_path(&session_path, &file_name)?;

    tauri::async_runtime::spawn_blocking(move || render::render_document(&file_path))
        .await
        .map_err(|error| format!("Failed to join render task: {error}"))?
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

async fn send_openai_compatible_messages(
    config: &PersistedAppConfig,
    messages: Vec<OpenAiCompatibleMessage>,
    temperature: f32,
) -> Result<String, String> {
    let mut base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Missing baseUrl for openai-compatible provider".to_string());
    }
    if !base_url.ends_with("/chat/completions") {
        base_url.push_str("/chat/completions");
    }

    let response = reqwest::Client::new()
        .post(base_url)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {}", config.api_key.trim()))
        .json(&OpenAiCompatibleChatRequest {
            model: config.model.clone(),
            messages,
            temperature,
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

/// Maximum number of characters returned when reading a file for the agent.
const MAX_TOOL_FILE_CHARS: usize = 60_000;

/// Maximum number of model round-trips allowed while resolving tool calls,
/// bounding cost and preventing infinite tool loops.
const MAX_TOOL_ITERATIONS: usize = 6;

/// JSON specification of the file-access tools exposed to the agent, in the
/// OpenAI-compatible function-calling format.
fn file_tool_specs() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_session_files",
                "description": "List the files available in the current reading session folder. Returns each file's name and processing status. Call this first when you are unsure of the exact file name to read.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the text contents of a file in the current session folder so you can summarize or analyze it. Works for text-based files (for example .md, .txt, .json, .csv, and source code), PDF documents, and Office documents (DOCX/PPTX, which require LibreOffice). Scanned or image-only PDFs may yield no text. Very large files are truncated.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_name": {
                            "type": "string",
                            "description": "The file name inside the session folder, exactly as listed by list_session_files."
                        }
                    },
                    "required": ["file_name"],
                    "additionalProperties": false
                }
            }
        }
    ])
}

/// List the files of a session folder as a human/agent-readable summary.
fn tool_list_session_files(session_path: &str) -> Result<String, String> {
    let session = session::read_folder_session(session_path)?;
    if session.files.is_empty() {
        return Ok("The session folder contains no files.".to_string());
    }

    let mut listing = format!("Files in session '{}':\n", session.title);
    for file in &session.files {
        listing.push_str(&format!("- {} (status: {})\n", file.name, file.status));
    }
    Ok(listing)
}

/// Read a session file as text, extracting from PDF/Office documents when
/// possible, and truncating very large content.
fn tool_read_file(session_path: &str, file_name: &str) -> Result<String, String> {
    let file_path = resolve_active_file_path(session_path, file_name)?;

    let content = match render::extract_document_text(&file_path) {
        Ok(text) => text,
        Err(error) => {
            return Ok(format!(
                "Could not read '{file_name}' as text: {error}"
            ));
        }
    };

    if content.trim().is_empty() {
        return Ok(format!(
            "The file '{file_name}' produced no extractable text (it may be empty, scanned, or image-only)."
        ));
    }

    if content.chars().count() > MAX_TOOL_FILE_CHARS {
        let truncated: String = content.chars().take(MAX_TOOL_FILE_CHARS).collect();
        Ok(format!(
            "{truncated}\n\n[Content truncated to the first {MAX_TOOL_FILE_CHARS} characters.]"
        ))
    } else {
        Ok(content)
    }
}

/// Dispatch a tool call requested by the model to its implementation.
fn execute_file_tool(
    session_path: Option<&str>,
    name: &str,
    arguments: &serde_json::Value,
) -> Result<String, String> {
    let session_path = session_path
        .ok_or_else(|| "No active session folder is available for file tools.".to_string())?;

    match name {
        "list_session_files" => tool_list_session_files(session_path),
        "read_file" => {
            let file_name = arguments
                .get("file_name")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "Missing required argument 'file_name'.".to_string())?;
            tool_read_file(session_path, file_name)
        }
        other => Err(format!("Unknown tool '{other}'.")),
    }
}

/// Run an OpenAI-compatible chat completion with the file-access tool loop.
///
/// When `session_path` is provided, the file tools are exposed to the model and
/// any requested tool calls are executed locally and fed back until the model
/// produces a final textual answer (bounded by `MAX_TOOL_ITERATIONS`).
async fn run_agentic_chat(
    config: &PersistedAppConfig,
    session_path: Option<&str>,
    mut messages: Vec<serde_json::Value>,
    temperature: f32,
) -> Result<String, String> {
    let mut base_url = config.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Missing baseUrl for openai-compatible provider".to_string());
    }
    if !base_url.ends_with("/chat/completions") {
        base_url.push_str("/chat/completions");
    }

    let tools = session_path.map(|_| file_tool_specs());
    let client = reqwest::Client::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": messages,
            "temperature": temperature,
        });
        if let Some(tools) = &tools {
            body["tools"] = tools.clone();
        }

        let response = client
            .post(&base_url)
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", config.api_key.trim()))
            .json(&body)
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

        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|error| format!("Failed to parse provider response: {error}"))?;

        let message = parsed
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .cloned()
            .ok_or_else(|| "Provider response did not contain choices".to_string())?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|value| value.as_array())
            .filter(|calls| !calls.is_empty())
            .cloned();

        let Some(calls) = tool_calls else {
            let content = message
                .get("content")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            return extract_response_text(content)
                .ok_or_else(|| "Provider response did not contain readable text content".to_string());
        };

        // Echo the assistant message (with its tool_calls) back verbatim so the
        // follow-up tool results line up with the requested call ids.
        messages.push(message);

        for call in calls {
            let call_id = call
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let function = call.get("function");
            let name = function
                .and_then(|function| function.get("name"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let raw_arguments = function
                .and_then(|function| function.get("arguments"))
                .and_then(|value| value.as_str())
                .unwrap_or("{}");
            let arguments: serde_json::Value =
                serde_json::from_str(raw_arguments).unwrap_or_else(|_| serde_json::json!({}));

            let result_text = match execute_file_tool(session_path, name, &arguments) {
                Ok(text) => text,
                Err(error) => format!("Tool error: {error}"),
            };

            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result_text,
            }));
        }
    }

    Err("The assistant kept requesting tools without producing a final answer. Please try again.".to_string())
}

async fn call_openai_compatible_chat(config: &PersistedAppConfig, request: &ChatRequest) -> Result<String, String> {
    let session_title = request.session_title.as_deref().unwrap_or("(none)");
    let session_path = request.session_path.as_deref().unwrap_or("(none)");
    let file_name = request.active_file_name.as_deref().unwrap_or("(none)");
    let file_status = request.active_file_status.as_deref().unwrap_or("(none)");

    let mut messages = vec![serde_json::json!({
        "role": "system",
        "content": "You are LexiLens, a reading and rewriting assistant. Use the provided session/file context to answer precisely and keep responses concise and helpful. When the user asks you to summarize or analyze a file, call the read_file tool to read its contents first (use list_session_files if you are unsure of the exact file name), and ground your answer only in the contents you have actually read."
    })];

    for message in request.recent_messages.iter().rev().take(8).rev() {
        let normalized_role = match message.role.as_str() {
            "assistant" | "user" | "system" => message.role.as_str(),
            _ => "user",
        };
        messages.push(serde_json::json!({
            "role": normalized_role,
            "content": message.text,
        }));
    }

    let contextual_user_prompt = format!(
        "Session title: {session_title}\nSession path: {session_path}\nActive file: {file_name}\nActive file status: {file_status}\n\nUser request:\n{}",
        request.user_message
    );

    messages.push(serde_json::json!({
        "role": "user",
        "content": contextual_user_prompt,
    }));

    let session_path_for_tools = request
        .session_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());

    run_agentic_chat(config, session_path_for_tools, messages, 0.3).await
}

async fn refine_text_for_speech(config: &PersistedAppConfig, text: &str) -> Result<String, String> {
    let system_prompt = "You normalize text so a text-to-speech engine reads it naturally. \
Rewrite the user's text fixing artifacts from PDF or document extraction: join words split across line breaks, \
remove stray hyphenation, collapse odd spacing, and expand abbreviations and symbols into spoken words \
(for example: 'Dr.' becomes 'Doctor', 'e.g.' becomes 'for example', 'Fig.' becomes 'Figure', '%' becomes 'percent', \
'&' becomes 'and', 'No.' becomes 'Number'). Keep the original meaning and language. Do not summarize, translate, \
explain, add commentary, or use markdown. Respond with ONLY the cleaned text.";

    let messages = vec![
        OpenAiCompatibleMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
        },
        OpenAiCompatibleMessage {
            role: "user".to_string(),
            content: text.to_string(),
        },
    ];

    send_openai_compatible_messages(config, messages, 0.2).await
}

#[tauri::command]
async fn preprocess_tts_text(app_handle: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Text cannot be empty".to_string());
    }

    let config_file_path = app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;
    let provider = config.provider.trim().to_ascii_lowercase();

    if provider != "openai-compatible" {
        // No remote LLM available for preprocessing; read the original text as-is.
        return Ok(trimmed.to_string());
    }

    if provider_requires_api_key(&provider) && config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let refined = refine_text_for_speech(&config, trimmed).await?;
    let refined = refined.trim();
    if refined.is_empty() {
        return Ok(trimmed.to_string());
    }

    Ok(refined.to_string())
}

#[derive(Serialize)]
struct GeminiTtsRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiGenerationConfig,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiTextPart>,
}

#[derive(Serialize)]
struct GeminiTextPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiGenerationConfig {
    #[serde(rename = "responseModalities")]
    response_modalities: Vec<String>,
    #[serde(rename = "speechConfig")]
    speech_config: GeminiSpeechConfig,
}

#[derive(Serialize)]
struct GeminiSpeechConfig {
    #[serde(rename = "voiceConfig")]
    voice_config: GeminiVoiceConfig,
}

#[derive(Serialize)]
struct GeminiVoiceConfig {
    #[serde(rename = "prebuiltVoiceConfig")]
    prebuilt_voice_config: GeminiPrebuiltVoiceConfig,
}

#[derive(Serialize)]
struct GeminiPrebuiltVoiceConfig {
    #[serde(rename = "voiceName")]
    voice_name: String,
}

#[derive(Deserialize)]
struct GeminiTtsResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiResponseContent,
}

#[derive(Deserialize)]
struct GeminiResponseContent {
    #[serde(default)]
    parts: Vec<GeminiResponsePart>,
}

#[derive(Deserialize)]
struct GeminiResponsePart {
    #[serde(rename = "inlineData")]
    inline_data: Option<GeminiInlineData>,
}

#[derive(Deserialize)]
struct GeminiInlineData {
    #[serde(rename = "mimeType")]
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizedSpeech {
    mime_type: String,
    audio_base64: String,
}

fn parse_pcm_sample_rate(mime_type: &str) -> u32 {
    mime_type
        .split(';')
        .find_map(|part| part.trim().strip_prefix("rate="))
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(24_000)
}

fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = pcm.len() as u32;

    let mut buffer = Vec::with_capacity(44 + pcm.len());
    buffer.extend_from_slice(b"RIFF");
    buffer.extend_from_slice(&(36 + data_len).to_le_bytes());
    buffer.extend_from_slice(b"WAVE");
    buffer.extend_from_slice(b"fmt ");
    buffer.extend_from_slice(&16u32.to_le_bytes());
    buffer.extend_from_slice(&1u16.to_le_bytes());
    buffer.extend_from_slice(&channels.to_le_bytes());
    buffer.extend_from_slice(&sample_rate.to_le_bytes());
    buffer.extend_from_slice(&byte_rate.to_le_bytes());
    buffer.extend_from_slice(&block_align.to_le_bytes());
    buffer.extend_from_slice(&bits_per_sample.to_le_bytes());
    buffer.extend_from_slice(b"data");
    buffer.extend_from_slice(&data_len.to_le_bytes());
    buffer.extend_from_slice(pcm);
    buffer
}

async fn call_gemini_tts(config: &PersistedAppConfig, text: &str) -> Result<SynthesizedSpeech, String> {
    let trimmed_base = config.base_url.trim().trim_end_matches('/');
    let native_base = trimmed_base.strip_suffix("/openai").unwrap_or(trimmed_base);
    let tts_model = config.tts_model.trim();
    let voice = if config.tts_voice.trim().is_empty() {
        "Kore"
    } else {
        config.tts_voice.trim()
    };

    let url = format!("{native_base}/models/{tts_model}:generateContent");

    let body = GeminiTtsRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiTextPart { text: text.to_string() }],
        }],
        generation_config: GeminiGenerationConfig {
            response_modalities: vec!["AUDIO".to_string()],
            speech_config: GeminiSpeechConfig {
                voice_config: GeminiVoiceConfig {
                    prebuilt_voice_config: GeminiPrebuiltVoiceConfig {
                        voice_name: voice.to_string(),
                    },
                },
            },
        },
    };

    let response = reqwest::Client::new()
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header("x-goog-api-key", config.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Failed to call provider TTS API: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable error body>".to_string());
        return Err(format!("Provider TTS API returned {status}: {error_body}"));
    }

    let parsed: GeminiTtsResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse provider TTS response: {error}"))?;

    let inline_data = parsed
        .candidates
        .into_iter()
        .flat_map(|candidate| candidate.content.parts)
        .find_map(|part| part.inline_data)
        .ok_or_else(|| "Provider TTS response did not contain audio data".to_string())?;

    let pcm = BASE64_STANDARD
        .decode(inline_data.data.as_bytes())
        .map_err(|error| format!("Failed to decode provider audio: {error}"))?;

    let sample_rate = parse_pcm_sample_rate(&inline_data.mime_type);
    let wav = pcm_to_wav(&pcm, sample_rate);

    Ok(SynthesizedSpeech {
        mime_type: "audio/wav".to_string(),
        audio_base64: BASE64_STANDARD.encode(wav),
    })
}

#[tauri::command]
async fn synthesize_speech(app_handle: AppHandle, text: String) -> Result<Option<SynthesizedSpeech>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Text cannot be empty".to_string());
    }

    let config_file_path = app_config_file_path(&app_handle)?;
    let config = session::load_app_config(&config_file_path)?;

    // When the user selects local/browser TTS, skip provider synthesis so the
    // frontend falls back to its built-in voice.
    if config.tts_mode.trim().eq_ignore_ascii_case("local") {
        return Ok(None);
    }

    // Provider-native TTS is currently available for Gemini's API. When it is not
    // configured/available, return None so the frontend falls back to its built-in voice.
    if config.tts_model.trim().is_empty() {
        return Ok(None);
    }
    if !config.base_url.contains("generativelanguage.googleapis.com") {
        return Ok(None);
    }
    if config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let audio = call_gemini_tts(&config, trimmed).await?;
    Ok(Some(audio))
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
            render_active_file,
            chat_with_context,
            preprocess_tts_text,
            synthesize_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

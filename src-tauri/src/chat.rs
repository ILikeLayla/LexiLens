use crate::app::{provider_requires_api_key, resolve_active_file_path};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use session::PersistedAppConfig;

const MAX_TOOL_FILE_CHARS: usize = 60_000;
const MAX_TOOL_ITERATIONS: usize = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    pub(crate) user_message: String,
    pub(crate) session_title: Option<String>,
    pub(crate) session_path: Option<String>,
    pub(crate) active_file_name: Option<String>,
    pub(crate) active_file_status: Option<String>,
    pub(crate) recent_messages: Vec<ChatMessageInput>,
}

#[derive(Deserialize)]
pub(crate) struct ChatMessageInput {
    pub(crate) role: String,
    pub(crate) text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatResponse {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) text: String,
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

pub(crate) async fn call_openai_compatible_chat(
    config: &PersistedAppConfig,
    request: &ChatRequest,
) -> Result<String, String> {
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

pub(crate) async fn preprocess_tts_text(
    config: &PersistedAppConfig,
    text: &str,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Text cannot be empty".to_string());
    }

    let provider = config.provider.trim().to_ascii_lowercase();
    if provider != "openai-compatible" {
        return Ok(trimmed.to_string());
    }

    if provider_requires_api_key(&provider) && config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let refined = refine_text_for_speech(config, trimmed).await?;
    let refined = refined.trim();
    if refined.is_empty() {
        return Ok(trimmed.to_string());
    }

    Ok(refined.to_string())
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

fn tool_read_file(session_path: &str, file_name: &str) -> Result<String, String> {
    let file_path = resolve_active_file_path(session_path, file_name)?;

    let content = match render::extract_document_text(&file_path) {
        Ok(text) => text,
        Err(error) => {
            return Ok(format!("Could not read '{file_name}' as text: {error}"));
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
            return extract_response_text(content).ok_or_else(|| {
                "Provider response did not contain readable text content".to_string()
            });
        };

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

    Err(
        "The assistant kept requesting tools without producing a final answer. Please try again."
            .to_string(),
    )
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

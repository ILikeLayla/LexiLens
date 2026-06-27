use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use session::PersistedAppConfig;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SynthesizedSpeech {
    pub(crate) mime_type: String,
    pub(crate) audio_base64: String,
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

pub(crate) async fn synthesize_with_config(
    config: &PersistedAppConfig,
    text: &str,
) -> Result<Option<SynthesizedSpeech>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Text cannot be empty".to_string());
    }

    if config.tts_mode.trim().eq_ignore_ascii_case("local") {
        return Ok(None);
    }
    if config.tts_model.trim().is_empty() {
        return Ok(None);
    }
    if !config
        .base_url
        .contains("generativelanguage.googleapis.com")
    {
        return Ok(None);
    }
    if config.api_key.trim().is_empty() {
        return Err("Missing required setting: apiKey".to_string());
    }

    let audio = call_gemini_tts(config, trimmed).await?;
    Ok(Some(audio))
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

async fn call_gemini_tts(
    config: &PersistedAppConfig,
    text: &str,
) -> Result<SynthesizedSpeech, String> {
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
            parts: vec![GeminiTextPart {
                text: text.to_string(),
            }],
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

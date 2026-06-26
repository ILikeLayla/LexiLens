use domain::LexiLensError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmProvider {
    OpenAiCompatible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiCompatibleConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RewriteRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub temperature: f32,
    pub max_output_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewriteResponse {
    pub provider: LlmProvider,
    pub model: String,
    pub text: String,
}

pub trait LlmRewriteClient {
    fn rewrite(&self, request: &RewriteRequest) -> Result<RewriteResponse, LexiLensError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticLlmRewriteClient {
    provider: LlmProvider,
    model: String,
}

impl StaticLlmRewriteClient {
    pub fn from_openai_compatible(config: OpenAiCompatibleConfig) -> Self {
        let _ = config.base_url;
        let _ = config.api_key;
        Self {
            provider: LlmProvider::OpenAiCompatible,
            model: config.model,
        }
    }
}

impl LlmRewriteClient for StaticLlmRewriteClient {
    fn rewrite(&self, request: &RewriteRequest) -> Result<RewriteResponse, LexiLensError> {
        if request.user_prompt.trim().is_empty() {
            return Err(LexiLensError::InvalidState(
                "rewrite request cannot be empty".to_string(),
            ));
        }

        Ok(RewriteResponse {
            provider: self.provider.clone(),
            model: self.model.clone(),
            text: request.user_prompt.trim().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_client_returns_prompt_text() {
        let client = StaticLlmRewriteClient::from_openai_compatible(OpenAiCompatibleConfig {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            api_key: "test-key".to_string(),
            model: "gemini-2.5-flash".to_string(),
        });

        let response = client
            .rewrite(&RewriteRequest {
                system_prompt: "Rewrite for grade 8.".to_string(),
                user_prompt: "Photosynthesis turns light into chemical energy.".to_string(),
                temperature: 0.2,
                max_output_tokens: Some(600),
            })
            .expect("rewrite should succeed");

        assert_eq!(response.provider, LlmProvider::OpenAiCompatible);
        assert_eq!(response.model, "gemini-2.5-flash");
        assert_eq!(
            response.text,
            "Photosynthesis turns light into chemical energy."
        );
    }

    #[test]
    fn static_client_rejects_empty_prompt() {
        let client = StaticLlmRewriteClient::from_openai_compatible(OpenAiCompatibleConfig {
            base_url: "https://example.com/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "gemini".to_string(),
        });

        let error = client
            .rewrite(&RewriteRequest {
                system_prompt: String::new(),
                user_prompt: "   ".to_string(),
                temperature: 0.0,
                max_output_tokens: None,
            })
            .expect_err("empty prompt must fail");

        assert!(matches!(error, LexiLensError::InvalidState(_)));
    }
}

use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSnapshot {
  pub source: String,
  pub content: String,
}

impl PageSnapshot {
  pub fn new(source: impl Into<String>, content: impl Into<String>) -> Self {
    Self {
      source: source.into(),
      content: content.into(),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBlock {
  pub id: String,
  pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadingSegment {
  pub id: String,
  pub label: String,
  pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightSpan {
  pub segment_id: String,
  pub start: usize,
  pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioTrack {
  pub format: String,
  pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
  pub id: String,
  pub title: String,
  pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthStatus {
  pub name: String,
  pub ready: bool,
  pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexiLensError {
  MissingCapability(&'static str),
  InvalidState(String),
  StorageUnavailable(String),
}

impl Display for LexiLensError {
  fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
    match self {
      Self::MissingCapability(capability) => write!(f, "missing capability: {capability}"),
      Self::InvalidState(message) => write!(f, "invalid state: {message}"),
      Self::StorageUnavailable(message) => write!(f, "storage unavailable: {message}"),
    }
  }
}

impl Error for LexiLensError {}

pub trait CaptureSource {
  fn capture(&self) -> Result<PageSnapshot, LexiLensError>;
}

pub trait TextExtractor {
  fn extract(&self, snapshot: &PageSnapshot) -> Result<Vec<TextBlock>, LexiLensError>;
}

pub trait TextRewriter {
  fn rewrite(&self, blocks: &[TextBlock]) -> Result<Vec<ReadingSegment>, LexiLensError>;
}

pub trait SpeechSynthesizer {
  fn synthesize(&self, segments: &[ReadingSegment]) -> Result<AudioTrack, LexiLensError>;
}

pub trait HighlightPlanner {
  fn plan(&self, segments: &[ReadingSegment]) -> Result<Vec<HighlightSpan>, LexiLensError>;
}

pub trait SessionStore {
  fn save(&mut self, record: SessionRecord) -> Result<(), LexiLensError>;
  fn load_all(&self) -> Result<Vec<SessionRecord>, LexiLensError>;
}

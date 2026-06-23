use domain::{CaptureSource, LexiLensError, PageSnapshot};

pub struct StaticCaptureSource {
  source: String,
  content: String,
}

impl Default for StaticCaptureSource {
  fn default() -> Self {
    Self {
      source: String::from("page-capture"),
      content: String::from("Captured text from the page is routed into the reading pipeline."),
    }
  }
}

impl CaptureSource for StaticCaptureSource {
  fn capture(&self) -> Result<PageSnapshot, LexiLensError> {
    Ok(PageSnapshot::new(self.source.clone(), self.content.clone()))
  }
}

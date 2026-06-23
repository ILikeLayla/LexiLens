use domain::{LexiLensError, PageSnapshot, TextBlock, TextExtractor};

pub struct StaticTextExtractor;

impl TextExtractor for StaticTextExtractor {
  fn extract(&self, snapshot: &PageSnapshot) -> Result<Vec<TextBlock>, LexiLensError> {
    Ok(vec![TextBlock {
      id: String::from("block-1"),
      text: snapshot.content.clone(),
    }])
  }
}

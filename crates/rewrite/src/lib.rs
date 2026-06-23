use domain::{LexiLensError, ReadingSegment, TextBlock, TextRewriter};

pub struct StaticTextRewriter;

impl TextRewriter for StaticTextRewriter {
  fn rewrite(&self, blocks: &[TextBlock]) -> Result<Vec<ReadingSegment>, LexiLensError> {
    Ok(blocks
      .iter()
      .enumerate()
      .map(|(index, block)| ReadingSegment {
        id: format!("segment-{}", index + 1),
        label: String::from("reading-section"),
        text: block.text.clone(),
      })
      .collect())
  }
}

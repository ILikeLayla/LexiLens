use domain::{HighlightPlanner, HighlightSpan, LexiLensError, ReadingSegment};

pub struct StaticHighlightPlanner;

impl HighlightPlanner for StaticHighlightPlanner {
  fn plan(&self, segments: &[ReadingSegment]) -> Result<Vec<HighlightSpan>, LexiLensError> {
    Ok(segments
      .iter()
      .map(|segment| HighlightSpan {
        segment_id: segment.id.clone(),
        start: 0,
        end: segment.text.len(),
      })
      .collect())
  }
}

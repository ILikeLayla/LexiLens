use domain::{AudioTrack, LexiLensError, ReadingSegment, SpeechSynthesizer};

pub struct StaticSpeechSynthesizer;

impl SpeechSynthesizer for StaticSpeechSynthesizer {
  fn synthesize(&self, segments: &[ReadingSegment]) -> Result<AudioTrack, LexiLensError> {
    let joined = segments
      .iter()
      .map(|segment| segment.text.as_str())
      .collect::<Vec<_>>()
      .join(" ");

    Ok(AudioTrack {
      format: String::from("placeholder/wav"),
      bytes: joined.into_bytes(),
    })
  }
}

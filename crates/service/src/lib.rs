use capture::StaticCaptureSource;
use domain::{
    AudioTrack, HealthStatus, HighlightSpan, LexiLensError, PageSnapshot, ReadingSegment,
    SessionRecord, TextBlock,
};
use highlight::StaticHighlightPlanner;
use ocr::StaticTextExtractor;
use rewrite::StaticTextRewriter;
use session::InMemorySessionStore;
use speech::StaticSpeechSynthesizer;

pub struct LexiLensRuntime {
    capture_source: Box<dyn domain::CaptureSource + Send + Sync>,
    text_extractor: Box<dyn domain::TextExtractor + Send + Sync>,
    text_rewriter: Box<dyn domain::TextRewriter + Send + Sync>,
    speech_synthesizer: Box<dyn domain::SpeechSynthesizer + Send + Sync>,
    highlight_planner: Box<dyn domain::HighlightPlanner + Send + Sync>,
    session_store: Box<dyn domain::SessionStore + Send>,
}

pub struct PipelineOutcome {
    pub snapshot: PageSnapshot,
    pub blocks: Vec<TextBlock>,
    pub segments: Vec<ReadingSegment>,
    pub highlights: Vec<HighlightSpan>,
    pub audio: AudioTrack,
}

impl LexiLensRuntime {
    pub fn new(
        capture_source: Box<dyn domain::CaptureSource + Send + Sync>,
        text_extractor: Box<dyn domain::TextExtractor + Send + Sync>,
        text_rewriter: Box<dyn domain::TextRewriter + Send + Sync>,
        speech_synthesizer: Box<dyn domain::SpeechSynthesizer + Send + Sync>,
        highlight_planner: Box<dyn domain::HighlightPlanner + Send + Sync>,
        session_store: Box<dyn domain::SessionStore + Send>,
    ) -> Self {
        Self {
            capture_source,
            text_extractor,
            text_rewriter,
            speech_synthesizer,
            highlight_planner,
            session_store,
        }
    }

    pub fn demo() -> Self {
        Self::new(
            Box::new(StaticCaptureSource::default()),
            Box::new(StaticTextExtractor),
            Box::new(StaticTextRewriter),
            Box::new(StaticSpeechSynthesizer),
            Box::new(StaticHighlightPlanner),
            Box::new(InMemorySessionStore::default()),
        )
    }

    pub fn run(&mut self) -> Result<PipelineOutcome, LexiLensError> {
        let snapshot = self.capture_source.capture()?;
        let blocks = self.text_extractor.extract(&snapshot)?;
        let segments = self.text_rewriter.rewrite(&blocks)?;
        let highlights = self.highlight_planner.plan(&segments)?;
        let audio = self.speech_synthesizer.synthesize(&segments)?;

        self.session_store.save(SessionRecord {
            id: String::from("session-1"),
            title: String::from("LexiLens reading flow"),
            summary: format!(
                "{} segments prepared from {}",
                segments.len(),
                snapshot.source
            ),
        })?;

        Ok(PipelineOutcome {
            snapshot,
            blocks,
            segments,
            highlights,
            audio,
        })
    }

    pub fn health(&self) -> HealthStatus {
        HealthStatus {
            name: String::from("lexilens-runtime"),
            ready: true,
            details: String::from("placeholder pipeline is wired end to end"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_runs_end_to_end() {
        let mut runtime = LexiLensRuntime::demo();
        let outcome = runtime.run().expect("pipeline should succeed");

        assert_eq!(outcome.blocks.len(), 1);
        assert_eq!(outcome.segments.len(), 1);
        assert_eq!(outcome.highlights.len(), 1);
        assert!(!outcome.audio.bytes.is_empty());
        assert!(runtime.health().ready);
    }
}

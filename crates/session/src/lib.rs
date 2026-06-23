use domain::{LexiLensError, SessionRecord, SessionStore};

#[derive(Default)]
pub struct InMemorySessionStore {
  sessions: Vec<SessionRecord>,
}

impl SessionStore for InMemorySessionStore {
  fn save(&mut self, record: SessionRecord) -> Result<(), LexiLensError> {
    self.sessions.push(record);
    Ok(())
  }

  fn load_all(&self) -> Result<Vec<SessionRecord>, LexiLensError> {
    Ok(self.sessions.clone())
  }
}

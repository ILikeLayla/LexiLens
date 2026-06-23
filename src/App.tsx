import { useState } from "react";
import "./App.css";

interface PipelineResult {
  source: string;
  blocks: number;
  segments: number;
  highlights: number;
  audio_bytes: number;
}

function App() {
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runPipeline() {
    setLoading(true);
    setError(null);
    try {
      // TODO: call your backend API here
      throw new Error("Backend not connected yet");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>LexiLens</h1>
      <p className="subtitle">Assistive reading — capture, rewrite, highlight, speak.</p>

      <button onClick={runPipeline} disabled={loading} className="btn-primary">
        {loading ? "Running…" : "Run Pipeline"}
      </button>

      {error && (
        <div className="result error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className="result">
          <h2>Pipeline Result</h2>
          <table>
            <tbody>
              <tr><th>Source</th><td>{result.source}</td></tr>
              <tr><th>Text Blocks</th><td>{result.blocks}</td></tr>
              <tr><th>Reading Segments</th><td>{result.segments}</td></tr>
              <tr><th>Highlights</th><td>{result.highlights}</td></tr>
              <tr><th>Audio Bytes</th><td>{result.audio_bytes}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export default App;

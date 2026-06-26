# LexiLens

LexiLens is a Tauri desktop app with a Rust backend and a React + TypeScript frontend.

- `src-tauri` hosts the Tauri commands and provider integrations.
- `crates/render` renders supported files into previewable output and extracts text for chat tools.
- `crates/session` stores local app state, settings, and folder session metadata.

The repository no longer includes the earlier placeholder pipeline crates that were not part of the running app.

## Desktop App

The repository root hosts the Bun + React + TypeScript frontend used by the desktop app.

- Install frontend dependencies with `bun install`.
- Start the desktop app in development with `bun run tauri dev`.
- Build the frontend bundle with `bun run build`.

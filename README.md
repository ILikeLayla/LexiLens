# LexiLens

LexiLens is scaffolded as a multi-crate Rust workspace that keeps the architecture abstract:

- `domain` defines the page-level domain types and traits.
- `capture`, `ocr`, `rewrite`, `speech`, `highlight`, and `session` provide the split components.
- `service` wires the pipeline together with placeholder adapters.

The project intentionally avoids concrete model names and external APIs at this stage.

## Desktop App

The repository root now also hosts a Tauri v2 desktop app with a Bun + React + TypeScript frontend.

- Install frontend dependencies with `bun install`.
- Start the desktop app in development with `bun run tauri dev`.
- Build the frontend bundle with `bun run build`.

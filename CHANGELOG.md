# Change Log

## 0.0.2 - 2026-10-16

- Add a selectable `cliproxyInline.reasoningEffort` (`minimal`/`low`/`medium`/`high`), a picker command and status bar indicator; the `reasoning_effort` parameter is omitted for the server default and forwarded for both completions and Next Edits.
- Add opt-in Next Edits for the active file: recent-edit context, exact-anchor validation, navigation, read-only diff preview, accept/reject and single-step undo/redo.
- Add optional debounced automatic predictions and scoped two-step Tab navigation, disabled by default.
- Clarify the cursor-completion task and separate document data from instructions; preserve significant whitespace, Markdown fences and document line endings.
- Keep insertion ranges consistent across cache hits, support selected IntelliSense items and discard obsolete responses.
- Bound context, history and prediction size; exclude sensitive filenames and untrusted/unsupported editors; redact backend error details.
- Add deterministic HTTP/editor-adapter tests and a real VS Code Extension Host test harness.
- Resume Next Edits history tracking when an initially selected editor becomes eligible.

## 0.0.1

- Initial release: inline completions backed by a CLIProxyApi server.
- Commands to toggle completions, trigger manually, and select a model.
- Configurable base URL, API key, model, context size, debounce, and timeout.

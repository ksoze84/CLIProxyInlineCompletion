# Change Log

## Unreleased

- Accepting a next edit immediately requests the next one, so a rename or signature change can be propagated with repeated accepts.
- Fix `Tab` accepting a stale inline completion instead of a next edit: when a next edit appears, visible ghost text is hidden, the in-flight completion is cancelled and no completion is offered while the next edit is shown.
- Add **Set CLIProxyApi URL** with URL validation, and **Select Next Edits Model** / **Select Next Edits Reasoning Effort** to the Command Palette. Model and effort commands are now labelled per feature and update the setting at the scope where it is defined.
- Remove Next Edits token limits: send the whole document and full changed lines, and omit `max_tokens`.
- Fix automatic Next Edits almost never running: it waited only 800 ms and was dropped whenever an inline completion was in flight. It now waits for the completion to finish, and completions and Next Edits no longer cancel each other.
- Moving the cursor no longer cancels or discards a pending Next Edit; only document changes do.
- Send Next Edits history grouped into whole edits with line numbers instead of individual keystrokes and offsets.
- Log truncated Next Edits responses.
- Accept a Next Edits response wrapped in a single `json` code block.
- Add `cliproxyInline.nextEdits.model` and `cliproxyInline.nextEdits.reasoningEffort` to use a different model for Next Edits.
- Log one line per Next Edits attempt with its outcome and latency, without code or prompts.
- Add opt-in live tests against a real CLIProxyApi (`npm run test:live`).

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

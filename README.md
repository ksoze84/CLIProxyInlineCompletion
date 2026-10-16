# CLIProxyApi Inline Completion

Inline completions (ghost text) and reviewable next edit suggestions in VS Code powered by [CLIProxyApi](https://github.com/router-for-me/CLIProxyAPI).

## Requirements

VS Code 1.90 or newer and a running CLIProxyApi server. By default the extension targets `http://127.0.0.1:8317`. The selected model must support chat completions; Next Edits also requires reliable JSON output.

## Install from source

```bash
npm install
npm run package
code --install-extension cliproxy-inline-completion-0.0.1.vsix
```

## Usage

Type in an eligible file and suggestions appear as ghost text. Press `Tab` to accept. Completions use the code before and after the cursor, with compatible IntelliSense ranges and cancellation of obsolete requests.

Run **CLIProxy Inline: Select Model** to pick a model, and **CLIProxy Inline: Select Reasoning Effort** to choose a `reasoning_effort` level. The default is the server/model default; the parameter is only sent when a level is chosen, so providers that do not support it are unaffected. It applies to both completions and Next Edits.

### Next Edits

1. Enable `cliproxyInline.nextEdits.enabled` in settings.
2. Make a small change, such as renaming a function declaration.
3. Run **CLIProxy Inline: Suggest Next Edit**. A valid related edit is marked in the source and status bar without changing the file.
4. Use **Go To Next Edit** to navigate or **Preview Next Edit** to compare read-only before/after snapshots.
5. Use **Accept Next Edit** or **Reject Next Edit** from the Command Palette or editor title actions. Acceptance works from the preview too and is one undoable operation. It never saves the file.

Automatic predictions and Tab navigation are separate opt-in settings. Automatic NES waits 800 ms after editing and yields to inline completion requests. Acceptance does not start an automatic chain. With Tab navigation enabled, the first Tab navigates and the second accepts at the destination, unless IntelliSense, ghost text, a snippet or another conflicting editor mode is active. Escape dismisses an available proposal when no conflicting widget is active. Use the commands if another extension owns these keys.

This uses stable VS Code APIs, not Copilot's experimental inline-edit renderer. It predicts one contiguous insertion, replacement or deletion in the active file. Ambiguous anchors, invalid JSON, oversized changes and results for an older document version are discarded. Changing the source invalidates its proposal; request a new one instead of applying a stale diff. No recent edits can mean no suggestion.

| Command | Description |
| --- | --- |
| `CLIProxy Inline: Toggle Inline Completions` | Enable/disable suggestions |
| `CLIProxy Inline: Trigger Inline Completion` | Request a suggestion manually |
| `CLIProxy Inline: Select Model` | Pick a model from `/v1/models` |
| `CLIProxy Inline: Select Reasoning Effort` | Pick the `reasoning_effort` level |
| `CLIProxy Inline: Suggest Next Edit` | Predict one change related to recent edits |
| `CLIProxy Inline: Go To Next Edit` | Navigate without applying |
| `CLIProxy Inline: Preview Next Edit` | Compare read-only snapshots |
| `CLIProxy Inline: Accept Next Edit` | Apply the current valid proposal |
| `CLIProxy Inline: Reject Next Edit` | Discard the proposal |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cliproxyInline.enabled` | `true` | Enable inline completions |
| `cliproxyInline.baseUrl` | `http://127.0.0.1:8317` | CLIProxyApi server URL |
| `cliproxyInline.apiKey` | `""` | Sent as `Authorization: Bearer <key>` |
| `cliproxyInline.model` | `gpt-4o-mini` | Model id to request |
| `cliproxyInline.reasoningEffort` | `""` | `reasoning_effort` level (`minimal`/`low`/`medium`/`high`); empty omits it |
| `cliproxyInline.maxTokens` | `256` | Max tokens per completion |
| `cliproxyInline.temperature` | `0.1` | Sampling temperature |
| `cliproxyInline.debounceMs` | `300` | Delay before requesting |
| `cliproxyInline.requestTimeoutMs` | `15000` | Request timeout |
| `cliproxyInline.prefixLines` | `120` | Lines of context before the cursor |
| `cliproxyInline.suffixLines` | `60` | Lines of context after the cursor |
| `cliproxyInline.languages` | `["*"]` | Language ids where completions are offered |
| `cliproxyInline.systemPrompt` | `""` | Extra instructions for the model |
| `cliproxyInline.nextEdits.enabled` | `false` | Enable manual Next Edits |
| `cliproxyInline.nextEdits.automatic` | `false` | Predict after an editing pause |
| `cliproxyInline.nextEdits.tabNavigation` | `false` | Opt in to two-step Tab navigation/acceptance |

## Privacy and limits

The local proxy may forward code to remote providers. Local transport is not a guarantee of local inference. Document content is sent only for suggestions; recent edit history is bounded in memory, never stored on disk. Logs omit code, prompts, raw responses and credentials, including HTTP error bodies.

Suggestions require a trusted workspace, an eligible writable `file`, `untitled` or `vscode-remote` document, and one empty selection. Virtual previews, output documents, `.env` variants, `.ssh`, common private-key files and credential filenames are excluded. This is not comprehensive secret detection: do not use the extension on sensitive material. The language filter and global toggle apply to both features.

Context is limited to 24,000 UTF-16 characters including serialized data and prompt allowances. Very long lines may result in no request. NES keeps up to 16 recent events for 60 seconds, with a 6,000-character history budget. On large files it sees only a contiguous window; it cannot find every reference in the file. NES tracking is skipped above two million characters. Proposals are limited to 64 lines and 8,000 characters per side; output has a separate 1,024-token budget. No extra files are sent or indexed.

The chat completion contract approximates fill-in-the-middle behavior; it is not native FIM and does not guarantee Copilot-equivalent quality. A model that answers conversationally or returns unreliable JSON may abstain frequently. `systemPrompt` customizes cursor completions only; NES has a separate fixed output contract.

## Development and verification

```bash
npm run test:unit
npm run test:integration
VSCODE_TEST_VERSION=1.90.0 npm run test:integration
npm run package
```

Unit tests include an in-memory editor adapter and synthetic HTTP server. Integration tests launch an isolated VS Code Extension Host and never send fixture code to an external model. Downloads require access to the official VS Code CDN and Electron requires a display (or Xvfb on headless Linux). See [implementation and verification results](docs/resultados-implementacion.md) for actual coverage and remaining checks.

## License

MIT

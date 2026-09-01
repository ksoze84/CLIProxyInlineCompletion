# CLIProxyApi Inline Completion

Inline completions (ghost text) in VS Code powered by a local [CLIProxyApi](https://github.com/router-for-me/CLIProxyAPI) server.

## Requirements

A running CLIProxyApi server. By default the extension targets `http://127.0.0.1:8317`.

## Install from source

```bash
npm install
npm run package
code --install-extension cliproxy-inline-completion-0.0.1.vsix
```

## Usage

Type in any file and suggestions appear as ghost text. Press `Tab` to accept.

| Command | Description |
| --- | --- |
| `CLIProxy Inline: Toggle Inline Completions` | Enable/disable suggestions |
| `CLIProxy Inline: Trigger Inline Completion` | Request a suggestion manually |
| `CLIProxy Inline: Select Model` | Pick a model from `/v1/models` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cliproxyInline.enabled` | `true` | Enable inline completions |
| `cliproxyInline.baseUrl` | `http://127.0.0.1:8317` | CLIProxyApi server URL |
| `cliproxyInline.apiKey` | `""` | Sent as `Authorization: Bearer <key>` |
| `cliproxyInline.model` | `gpt-4o-mini` | Model id to request |
| `cliproxyInline.maxTokens` | `256` | Max tokens per completion |
| `cliproxyInline.temperature` | `0.1` | Sampling temperature |
| `cliproxyInline.debounceMs` | `300` | Delay before requesting |
| `cliproxyInline.requestTimeoutMs` | `15000` | Request timeout |
| `cliproxyInline.prefixLines` | `120` | Lines of context before the cursor |
| `cliproxyInline.suffixLines` | `60` | Lines of context after the cursor |
| `cliproxyInline.languages` | `["*"]` | Language ids where completions are offered |
| `cliproxyInline.systemPrompt` | `""` | Extra instructions for the model |

## License

MIT

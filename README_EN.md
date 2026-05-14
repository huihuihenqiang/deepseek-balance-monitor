# AI Usage Monitor

AI Usage Monitor is a VS Code extension for tracking DeepSeek balance, Claude Code token usage, and a draggable desktop pet that reacts to your usage.

[中文文档](README.md)

## Features

- DeepSeek balance and recent spending trend
- Claude Code daily, weekly, monthly, and cumulative token dashboard
- Project ranking, model breakdown, cache usage, and monthly forecast
- Markdown monthly report export
- Floating pet with local sprites, chat, drag interactions, and token usage warnings

## Install Latest

1. Download the latest `.vsix` from GitHub Releases.
2. Open VS Code.
3. Run `Extensions: Install from VSIX...` from the command palette.
4. Select the downloaded VSIX and reload VS Code.

Command-line install:

```bash
code --install-extension deepseek-balance-monitor-0.3.2.vsix
```

## Runtime Notes

Users do not need Node.js, npm, Codex, or petdex.

The floating pet uses Electron. In development, the extension uses `node_modules/electron`. In packaged VSIX builds, Electron is downloaded on the first pet launch and cached in VS Code globalStorage. After the runtime is cached, the pet window can start offline.

The VSIX includes three built-in pets:

- `anya-2`
- `tiko`
- `xiaoyu-3`

If a selected pet slug is not found locally or in the bundled assets, the extension tries to download it from the Petdex manifest and caches it.

## Configuration

Search `deepseek-balance` in VS Code settings.

| Setting | Default | Description |
| --- | --- | --- |
| `deepseek-balance.apiKey` | empty | DeepSeek API key, also used by pet chat |
| `deepseek-balance.refreshInterval` | `30` | Auto-refresh interval in minutes |
| `deepseek-balance.currency` | `auto` | Balance display currency |
| `deepseek-balance.petEnabled` | `false` | Start the pet when VS Code activates |
| `deepseek-balance.petSlug` | `anya-2` | Current pet slug |
| `deepseek-balance.petChatBaseUrl` | `https://api.deepseek.com/v1` | OpenAI-compatible chat endpoint |
| `deepseek-balance.petChatModel` | `deepseek-v4-flash` | Pet chat model |
| `deepseek-balance.monthlyTokenBudget` | `0` | Monthly token budget. 0 disables budget alerts |

## Pet Assets

When Chat is open, the panel only shows the input box. Pet replies are shown as the pet bubble and stay visible until Chat is closed. Non-chat bubbles still use the normal 7-second lifetime.

Use the sidebar gear menu and choose `Import Local Pet`, then select a folder containing:

```text
pet.json
spritesheet.webp
```

`spritesheet.png` is also supported.

Manual pet folders are also supported:

```text
~/.ai-usage-monitor/pets/<slug>
~/.codex/pets/<slug>
~/.petdex/pets/<slug>
```

Asset lookup priority:

1. `~/.ai-usage-monitor/pets/<slug>`
2. `~/.codex/pets/<slug>`
3. `~/.petdex/pets/<slug>`
4. Imported assets in VS Code globalStorage
5. Bundled assets under `media/pets/<slug>`
6. Download cache in VS Code globalStorage
7. Petdex online manifest

## Privacy

- API keys are stored locally in VS Code settings.
- Pet chat requests are sent from the extension process. The key is not exposed to the pet window.
- Claude Code usage is read from local `.claude/projects` logs.
- No telemetry.

## Build

```bash
npm install
npm run compile
npx vsce package --allow-star-activation
```

## License

MIT

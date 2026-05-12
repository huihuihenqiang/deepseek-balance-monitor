# DeepSeek Balance Monitor

VS Code extension to monitor your [DeepSeek](https://platform.deepseek.com/) API balance in real-time.

## Features

- **Sidebar panel** — View your current balance, topped-up vs. granted breakdown
- **Balance trend chart** — Track balance changes over the past 7 days
- **Consumption stats** — See how much you've spent in the last hour / 24 hours / 7 days
- **Auto-refresh** — Polls the DeepSeek API at configurable intervals (default 30 min)

## Installation

1. Download the latest `.vsix` file from [Releases](https://github.com/huihuihenqiang/deepseek-balance-monitor/releases)
2. In VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` file
4. Reload VS Code
## Setup

1. `Ctrl+,` → search `deepseek-balance`
2. Paste your [DeepSeek API key](https://platform.deepseek.com/api_keys) in the `Api Key` field
3. Click the 📈 icon in the Activity Bar to open the balance panel

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `deepseek-balance.apiKey` | `""` | Your DeepSeek API key |
| `deepseek-balance.refreshInterval` | `30` | Auto-refresh interval in minutes (5-120) |
| `deepseek-balance.currency` | `"auto"` | Preferred currency: `CNY`, `USD`, or `auto` |

## Privacy

- Your API key is stored locally in VS Code settings and never sent anywhere except to `api.deepseek.com`
- The extension only calls `GET /user/balance` — it does not read or send any other data
- No telemetry, no tracking, no third-party services

## Build from source

```bash
npm install
npm run compile
npx vsce package --allow-star-activation --allow-missing-repository
```

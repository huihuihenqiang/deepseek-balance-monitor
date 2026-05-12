# AI Usage Monitor

> 🎯 Purpose-built for the **Claude Code + DeepSeek API** combo. Stop opening your browser to check your balance — see everything right in your VS Code sidebar.

[中文](README.md)

## Why You Need It

When using Claude Code with DeepSeek API, you face two pain points:
- Checking your balance → must open a browser and log into the DeepSeek dashboard
- Tracking token usage → nowhere to look until the bill arrives

**This extension solves both: balance + token consumption, all inside VS Code.**

## Features

### DeepSeek Balance Panel
- Real-time balance display (topped-up vs. granted breakdown)
- 7-day balance trend chart
- 1h / 24h / 7d consumption stats
- Smart hint when balance hasn't changed (API update may be delayed)

### Claude Code Usage Panel
- **Total Tokens** — input / output / cache breakdown
- **API Call Count** — how many times you've hit the API
- **Cache Hit Rate** — see how much Prompt Caching saves you
- **Bar Chart** — 7-day token usage trend
- **Model Distribution Pie** — which model consumes how many tokens
- **Project Ranking** — which project eats the most tokens
- **Monthly Forecast** — weighted prediction based on your usage patterns

## Installation

1. Download the latest `.vsix` from [Releases](https://github.com/huihuihenqiang/deepseek-balance-monitor/releases)
2. In VS Code: `Ctrl+Shift+P` → type `vsix` → `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` file
4. Reload VS Code

## Configuration

`Ctrl+,` → search `deepseek`:

| Setting | Default | Description |
|---------|---------|-------------|
| `Api Key` | (empty) | Your [DeepSeek API key](https://platform.deepseek.com/api_keys) |
| `Refresh Interval` | `30` | Auto-refresh interval in minutes (5-120) |
| `Currency` | `auto` | Display currency: `CNY`, `USD`, or `auto` |

## Usage

1. After setting your API Key, click the 📈 **AI Usage** icon in the Activity Bar
2. Top half = DeepSeek balance, bottom half = Claude Code usage
3. Click `⟳ Refresh` to manually refresh both
4. Usage data is extracted automatically from local session logs under `~/.claude/projects/` — no extra setup needed

## Privacy

- Your API key is stored locally and only sent to `api.deepseek.com`
- Only calls `GET /user/balance` — reads/writes no other data
- Claude Code session data is read locally only — **nothing is uploaded**
- No telemetry, no tracking, no third-party services

## Build from Source

```bash
npm install
npm run compile
npx vsce package --allow-star-activation --allow-missing-repository
```

## License

MIT

# Design: Claude Code Usage Integration

**Date:** 2026-05-12  
**Status:** Approved

## Overview

Extend the DeepSeek Balance Monitor VS Code extension with a Claude Code local usage statistics module. The top half (DeepSeek balance) stays unchanged except for a refresh hint. The bottom half is a new "Claude Code Usage" section showing token consumption, cost, model distribution, and session rankings parsed from `~/.claude/projects/` JSONL files.

## Architecture

```
src/
  extension.ts           — register claudeUsageService, coordinate both services
  balanceService.ts      — add refresh hint detection (balance unchanged → notify UI)
  claudeUsageService.ts  — NEW: scan local JSONL, compute stats (hybrid strategy)
  webviewProvider.ts     — aggregate both data sources, push unified messages
  historyStore.ts        — unchanged
  types.ts               — add ClaudeUsage, ModelPricing types
media/
  panel.js               — render new Claude module (Canvas-drawn charts, no libraries)
```

## Data Scanning Strategy (Hybrid — Option C)

1. **First scan**: full parse of all JSONL files under `~/.claude/projects/`, build baseline stats
2. **Subsequent scans**: check file `mtime`; only re-read files that changed, seeking to last-read line offset
3. Configurable interval, default 10 minutes

## UI Layout

```
┌─ DeepSeek Balance (existing, unchanged except refresh hint) ─┐
│  Balance card + 7-day trend + consumption stats              │
│  + NEW: "余额未变化，可能官方数据未更新，请稍后再试"         │
│    (appears when balance unchanged after manual refresh,     │
│     auto-dismiss after 3s)                                   │
├─ Claude Code Usage (NEW) ────────────────────────────────────┤
│  Overview cards: Total Tokens / Cost / Call Count / Cache HR │
│  Line chart: Token + Cost 7-day trend                        │
│  Pie chart: Model distribution                               │
│  List: Top 5 most expensive sessions                         │
│  Line: Monthly cost projection                               │
│  Buttons: Refresh / Export CSV                               │
└──────────────────────────────────────────────────────────────┘
```

## Data Model

```typescript
interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

interface ModelUsage extends TokenStats {
  model: string;
  callCount: number;
  cost: number;
}

interface SessionUsage {
  sessionId: string;
  projectDir: string;
  tokenStats: TokenStats;
  modelUsage: ModelUsage[];
  messageCount: number;
  startedAt: number;
  lastActiveAt: number;
}

interface DailyStats {
  date: string;
  tokenStats: TokenStats;
  cost: number;
  callCount: number;
  models: Record<string, TokenStats>;
}

interface ClaudeUsageData {
  tokenStats: TokenStats;
  totalCost: number;
  callCount: number;
  cacheHitRate: number;          // cacheRead / (input + cacheRead)
  modelUsage: ModelUsage[];
  dailyStats: DailyStats[];
  topSessions: SessionUsage[];   // by cost
  projectedMonthlyCost: number;
}
```

## Model Pricing (Configurable)

```json
"deepseek-balance.modelPricing": {
  "deepseek-v4-pro": {
    "inputPerMTok": 3.0,
    "cacheHitPerMTok": 0.025,
    "outputPerMTok": 6.0
  },
  "deepseek-v4-flash": {
    "inputPerMTok": 1.0,
    "cacheHitPerMTok": 0.02,
    "outputPerMTok": 2.0
  }
}
```

Unknown models default to v4-pro pricing.

## Configuration Additions

| Setting | Default | Description |
|---------|---------|-------------|
| `deepseek-balance.modelPricing` | (see above) | Per-model pricing for cost calculation |
| `deepseek-balance.claudeScanInterval` | `10` | Local JSONL scan interval in minutes |

## Charts (Canvas 2D, no libraries)

- Trend line chart: reuse existing canvas chart code in panel.js, adapted for token/cost dual-series
- Pie chart: hand-drawn arc segments with legend, ~50 lines

## What We're NOT Building

- Low-balance alerts
- Time-of-day heatmaps, anomaly detection, thinking/output ratio

## Scope

Single implementation cycle. All changes contained within the existing extension directory.

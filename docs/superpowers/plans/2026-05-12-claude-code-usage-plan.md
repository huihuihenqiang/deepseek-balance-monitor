# Claude Code Usage Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code usage statistics module (token, cost, model distribution, session ranking) sourced from local `~/.claude/projects/` JSONL files, plus a refresh hint on the existing DeepSeek balance panel.

**Architecture:** Two independent services (`balanceService` + new `claudeUsageService`) feed a single `webviewProvider` aggregation layer. All charts rendered with Canvas 2D API, no third-party libraries.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `fs`/`path`/`readline`, Canvas 2D

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add Claude usage types, model pricing config type |
| `src/claudeUsageService.ts` | **Create** | Scan local JSONL files, compute aggregated stats with incremental support |
| `src/balanceService.ts` | Modify | Track previous balance; emit `balanceUnchanged` flag on manual refresh when unchanged |
| `src/webviewProvider.ts` | Modify | Accept both balance and Claude data; forward refresh hint + claude usage messages |
| `src/extension.ts` | Modify | Wire up claudeUsageService; pass it to webviewProvider |
| `package.json` | Modify | Add `modelPricing` and `claudeScanInterval` configuration properties |
| `media/panel.js` | Modify | Render Claude Code usage section: overview cards, trend chart, pie chart, session ranking, cost projection, export button |

---

### Task 1: Add types for Claude usage and model pricing

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Write new type definitions**

```typescript
// Append to src/types.ts (keep all existing types unchanged):

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface ModelPricing {
  inputPerMTok: number;
  cacheHitPerMTok: number;
  outputPerMTok: number;
}

export interface ModelUsage extends TokenStats {
  model: string;
  callCount: number;
  cost: number;
}

export interface SessionUsage {
  sessionId: string;
  projectDir: string;
  tokenStats: TokenStats;
  modelUsage: ModelUsage[];
  messageCount: number;
  startedAt: number;
  lastActiveAt: number;
}

export interface DailyStats {
  date: string;
  tokenStats: TokenStats;
  cost: number;
  callCount: number;
  models: Record<string, TokenStats>;
}

export interface ClaudeUsageData {
  tokenStats: TokenStats;
  totalCost: number;
  callCount: number;
  cacheHitRate: number;
  modelUsage: ModelUsage[];
  dailyStats: DailyStats[];
  topSessions: SessionUsage[];
  projectedMonthlyCost: number;
}

export interface RefreshHint {
  show: boolean;
  message: string;
}
```

- [ ] **Step 2: Compile and check for errors**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors (new types are additive, no breaks).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Claude usage and model pricing types"
```

---

### Task 2: Create ClaudeUsageService

**Files:**
- Create: `src/claudeUsageService.ts`

- [ ] **Step 1: Write the service file**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import {
  TokenStats, ModelPricing, ModelUsage, SessionUsage,
  DailyStats, ClaudeUsageData
} from './types';

function sumStats(stats: TokenStats[]): TokenStats {
  const r: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  for (const s of stats) {
    r.inputTokens += s.inputTokens;
    r.outputTokens += s.outputTokens;
    r.cacheReadTokens += s.cacheReadTokens;
    r.cacheCreateTokens += s.cacheCreateTokens;
  }
  return r;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class ClaudeUsageService {
  private _onDidUpdate = new vscode.EventEmitter<ClaudeUsageData>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private timer: NodeJS.Timeout | null = null;
  private lastOffsets: Map<string, number> = new Map();
  private parsedMessages: Map<string, any[]> = new Map(); // sessionId -> messages

  constructor(
    private getConfig: () => { scanInterval: number; modelPricing: Record<string, ModelPricing> }
  ) {}

  start(): void {
    this.scan();
    const intervalMs = (this.getConfig().scanInterval || 10) * 60 * 1000;
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  /** Public for manual refresh */
  async scan(): Promise<void> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) { return; }

    const projectDirs = fs.readdirSync(projectsDir).filter(d => {
      const full = path.join(projectsDir, d);
      return fs.statSync(full).isDirectory();
    });

    for (const dir of projectDirs) {
      const projectPath = path.join(projectsDir, dir);
      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const key = filePath;
        const mtime = fs.statSync(filePath).mtimeMs;
        const lastOffset = this.lastOffsets.get(key) || 0;
        // Full read if no offset, else skip if mtime unchanged
        if (lastOffset > 0) {
          // Incremental: read from lastOffset
          await this.readLines(filePath, lastOffset, key, dir);
        } else {
          // Full read
          await this.readLines(filePath, 0, key, dir);
        }
        // Record current file size as offset for next scan
        this.lastOffsets.set(key, fs.statSync(filePath).size);
      }
    }

    const data = this.computeUsage();
    this._onDidUpdate.fire(data);
  }

  private async readLines(
    filePath: string, startOffset: number, mapKey: string, projectDir: string
  ): Promise<void> {
    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, {
        encoding: 'utf-8',
        start: startOffset,
      });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const messages = this.parsedMessages.get(mapKey) || [];
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line);
          obj._projectDir = projectDir;
          messages.push(obj);
        } catch { /* skip malformed lines */ }
      });
      rl.on('close', () => {
        this.parsedMessages.set(mapKey, messages);
        resolve();
      });
      stream.on('error', () => resolve());
    });
  }

  private computeUsage(): ClaudeUsageData {
    const pricing = this.getConfig().modelPricing || {};
    const defaultPricing: ModelPricing = { inputPerMTok: 3.0, cacheHitPerMTok: 0.025, outputPerMTok: 6.0 };

    const modelMap = new Map<string, { stats: TokenStats; count: number }>();
    const sessionMap = new Map<string, SessionUsage>();
    const dailyMap = new Map<string, { stats: TokenStats; count: number; models: Record<string, TokenStats> }>();
    let globalStats: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    let callCount = 0;

    for (const [, messages] of this.parsedMessages) {
      for (const msg of messages) {
        if (msg.type !== 'assistant' || !msg.usage) { continue; }
        const usage = msg.usage;
        const model = msg.model || 'unknown';
        callCount++;

        // Accumulate global
        globalStats.inputTokens += usage.input_tokens || 0;
        globalStats.outputTokens += usage.output_tokens || 0;
        globalStats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        globalStats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;

        // Per model
        let mm = modelMap.get(model);
        if (!mm) { mm = { stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, count: 0 }; modelMap.set(model, mm); }
        mm.stats.inputTokens += usage.input_tokens || 0;
        mm.stats.outputTokens += usage.output_tokens || 0;
        mm.stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        mm.stats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
        mm.count++;

        // Per session
        const sid = msg.sessionId || 'unknown';
        let ss = sessionMap.get(sid);
        if (!ss) {
          ss = {
            sessionId: sid,
            projectDir: msg._projectDir || '',
            tokenStats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
            modelUsage: [],
            messageCount: 0,
            startedAt: new Date(msg.timestamp).getTime(),
            lastActiveAt: new Date(msg.timestamp).getTime(),
          };
          sessionMap.set(sid, ss);
        }
        ss.tokenStats.inputTokens += usage.input_tokens || 0;
        ss.tokenStats.outputTokens += usage.output_tokens || 0;
        ss.tokenStats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        ss.tokenStats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
        ss.messageCount++;
        const ts = new Date(msg.timestamp).getTime();
        if (ts < ss.startedAt) { ss.startedAt = ts; }
        if (ts > ss.lastActiveAt) { ss.lastActiveAt = ts; }

        // Per day
        const date = formatDate(new Date(msg.timestamp).getTime());
        let dd = dailyMap.get(date);
        if (!dd) { dd = { stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, count: 0, models: {} }; dailyMap.set(date, dd); }
        dd.stats.inputTokens += usage.input_tokens || 0;
        dd.stats.outputTokens += usage.output_tokens || 0;
        dd.stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        dd.stats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
        dd.count++;
        if (!dd.models[model]) { dd.models[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }; }
        dd.models[model].inputTokens += usage.input_tokens || 0;
        dd.models[model].outputTokens += usage.output_tokens || 0;
        dd.models[model].cacheReadTokens += usage.cache_read_input_tokens || 0;
        dd.models[model].cacheCreateTokens += usage.cache_creation_input_tokens || 0;
      }
    }

    // Compute model usage with cost
    const modelUsage: ModelUsage[] = [];
    for (const [model, m] of modelMap) {
      const p = pricing[model] || defaultPricing;
      const cost =
        (m.stats.inputTokens / 1_000_000) * p.inputPerMTok +
        (m.stats.cacheReadTokens / 1_000_000) * p.cacheHitPerMTok +
        (m.stats.outputTokens / 1_000_000) * p.outputPerMTok;
      modelUsage.push({ model, ...m.stats, callCount: m.count, cost });
    }
    modelUsage.sort((a, b) => b.cost - a.cost);

    // Compute total cost
    let totalCost = 0;
    for (const m of modelUsage) { totalCost += m.cost; }

    // Cache hit rate
    const totalInput = globalStats.inputTokens + globalStats.cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? globalStats.cacheReadTokens / totalInput : 0;

    // Daily stats with cost
    const dailyStats: DailyStats[] = [];
    for (const [date, d] of dailyMap) {
      let cost = 0;
      for (const [model, ts] of Object.entries(d.models)) {
        const p = pricing[model] || defaultPricing;
        cost +=
          (ts.inputTokens / 1_000_000) * p.inputPerMTok +
          (ts.cacheReadTokens / 1_000_000) * p.cacheHitPerMTok +
          (ts.outputTokens / 1_000_000) * p.outputPerMTok;
      }
      dailyStats.push({ date, tokenStats: d.stats, cost, callCount: d.count, models: d.models });
    }
    dailyStats.sort((a, b) => a.date.localeCompare(b.date));

    // Top sessions (by cost) — compute per-session model usage + cost
    const sessions: SessionUsage[] = [];
    for (const [, s] of sessionMap) {
      const smModels = new Map<string, { stats: TokenStats; count: number }>();
      for (const msg of (this.parsedMessages.get(s.sessionId) || [])) {
        if (msg.type !== 'assistant' || !msg.usage) { continue; }
        const model = msg.model || 'unknown';
        let sm = smModels.get(model);
        if (!sm) { sm = { stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, count: 0 }; smModels.set(model, sm); }
        sm.stats.inputTokens += msg.usage.input_tokens || 0;
        sm.stats.outputTokens += msg.usage.output_tokens || 0;
        sm.stats.cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
        sm.stats.cacheCreateTokens += msg.usage.cache_creation_input_tokens || 0;
        sm.count++;
      }
      const modelUsage: ModelUsage[] = [];
      for (const [model, m] of smModels) {
        const p = pricing[model] || defaultPricing;
        const cost =
          (m.stats.inputTokens / 1_000_000) * p.inputPerMTok +
          (m.stats.cacheReadTokens / 1_000_000) * p.cacheHitPerMTok +
          (m.stats.outputTokens / 1_000_000) * p.outputPerMTok;
        modelUsage.push({ model, ...m.stats, callCount: m.count, cost });
      }
      sessions.push({ ...s, modelUsage });
    }
    sessions.sort((a, b) => {
      const costA = a.modelUsage.reduce((sum, m) => sum + m.cost, 0);
      const costB = b.modelUsage.reduce((sum, m) => sum + m.cost, 0);
      return costB - costA;
    });
    const topSessions = sessions.slice(0, 5);

    // Projected monthly cost
    const daysCovered = dailyStats.length || 1;
    const projectedMonthlyCost = (totalCost / daysCovered) * 30;

    return {
      tokenStats: globalStats,
      totalCost,
      callCount,
      cacheHitRate: Math.round(cacheHitRate * 10000) / 10000,
      modelUsage,
      dailyStats,
      topSessions,
      projectedMonthlyCost,
    };
  }
}
```

- [ ] **Step 2: Compile**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/claudeUsageService.ts
git commit -m "feat: add Claude usage service with local JSONL scanning"
```

---

### Task 3: Add refresh hint to BalanceService

**Files:**
- Modify: `src/balanceService.ts`

- [ ] **Step 1: Add manual refresh method that detects unchanged balance**

Replace the `fetch` method and add `fetchWithHint`:

In `balanceService.ts`, find the `fetch()` method (line 45). Change it to extract the HTTP logic, and add a new public method `fetchManual()`:

```typescript
// Change the existing fetch() to always be the "silent" path (no hint):
async fetch(): Promise<void> {
  return this._fetch(false);
}

// New method for manual refresh that triggers hint when balance unchanged:
async fetchManual(): Promise<void> {
  return this._fetch(true);
}

// Internal implementation:
private async _fetch(checkUnchanged: boolean): Promise<void> {
  if (this.isFetching) { return; }
  this.isFetching = true;

  try {
    const config = this.getConfig();
    if (!config.apiKey) {
      this._onDidUpdate.fire({
        balance: { currency: '', totalBalance: '0', grantedBalance: '0', toppedUpBalance: '0' },
        previousBalance: null,
      });
      return;
    }

    const data = await this.httpGet(config.apiKey);
    const currency = config.currency === 'auto' ? data.balanceInfos[0]?.currency || 'CNY' : config.currency;
    const info = data.balanceInfos.find((b) => b.currency === currency) || data.balanceInfos[0];

    if (!info) { throw new Error('No balance data returned'); }

    const balance: BalanceInfo = { ...info };

    // Check if balance is unchanged from last fetch
    const unchanged = checkUnchanged &&
      this.lastBalance !== null &&
      this.lastBalance.totalBalance === balance.totalBalance &&
      this.lastBalance.currency === balance.currency;

    const snapshot: Snapshot = { ...balance, timestamp: Date.now() };
    this.historyStore.addSnapshot(snapshot);

    this._onDidUpdate.fire({
      balance,
      previousBalance: this.lastBalance,
      balanceUnchanged: unchanged,
    });
    this.lastBalance = balance;
  } catch (err: any) {
    const error = err.statusCode === 401 ? 'invalid-key' : String(err.message || err);
    this._onDidUpdate.fire({
      balance: this.lastBalance || { currency: '', totalBalance: '0', grantedBalance: '0', toppedUpBalance: '0' },
      previousBalance: null,
      error,
    });
  } finally {
    this.isFetching = false;
  }
}
```

Also add `balanceUnchanged?: boolean` to the event payload type at line 8-12. The event payload interface is inline, update it:

```typescript
private _onDidUpdate = new vscode.EventEmitter<{
  balance: BalanceInfo;
  previousBalance: BalanceInfo | null;
  error?: string;
  balanceUnchanged?: boolean;
}>();
```

- [ ] **Step 2: Update extension.ts to call `fetchManual` on manual refresh**

In `extension.ts`, find the command handler `'deepseek-balance.refresh'` (around line 75). Change `balanceService.fetch()` to `balanceService.fetchManual()`:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('deepseek-balance.refresh', async () => {
    LOG('Manual refresh triggered');
    panelProvider.setRefreshing(true);
    await balanceService.fetchManual();  // changed from fetch()
    panelProvider.setRefreshing(false);
  })
);
```

- [ ] **Step 3: Update webviewProvider to handle and forward the hint**

In `webviewProvider.ts`, update the `onDidUpdate` handler (in `extension.ts` around line 36) to check `balanceUnchanged` and call a new method on panelProvider:

```typescript
balanceService.onDidUpdate(({ balance, error, balanceUnchanged }) => {
  LOG('Balance update: error=' + (error || 'none') + ' unchanged=' + !!balanceUnchanged);
  if (error === 'no-api-key') {
    panelProvider.showError('Please set your DeepSeek API key in settings.');
    return;
  }
  if (error === 'invalid-key') {
    panelProvider.showError('Invalid API key. Please check your key in settings.');
    return;
  }
  if (error) {
    panelProvider.showError(error);
    return;
  }
  panelProvider.update({
    currency: balance.currency,
    total: balance.totalBalance,
    granted: balance.grantedBalance,
    toppedUp: balance.toppedUpBalance,
  });
  if (balanceUnchanged) {
    panelProvider.showRefreshHint();
  }
});
```

- [ ] **Step 4: Add `showRefreshHint` method to webviewProvider**

Add to `src/webviewProvider.ts`:

```typescript
showRefreshHint(): void {
  if (!this._view) { return; }
  this._view.webview.postMessage({ command: 'refreshHint', message: '余额未变化，可能官方数据未更新，请稍后再试' });
}
```

- [ ] **Step 5: Handle refreshHint in panel.js** — will do in Task 7

- [ ] **Step 6: Compile**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add src/balanceService.ts src/extension.ts src/webviewProvider.ts
git commit -m "feat: add balance unchanged refresh hint"
```

---

### Task 4: Wire ClaudeUsageService in extension.ts and forward data

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/webviewProvider.ts`

- [ ] **Step 1: Create ClaudeUsageService in extension.ts and forward its data**

In `extension.ts`, after `balanceService` instantiation (line 24), add:

```typescript
// Claude Code usage service
function getPricingConfig(): Record<string, import('./types').ModelPricing> {
  const cfg = vscode.workspace.getConfiguration('deepseek-balance');
  return cfg.get<Record<string, import('./types').ModelPricing>>('modelPricing', {
    'deepseek-v4-pro': { inputPerMTok: 3.0, cacheHitPerMTok: 0.025, outputPerMTok: 6.0 },
    'deepseek-v4-flash': { inputPerMTok: 1.0, cacheHitPerMTok: 0.02, outputPerMTok: 2.0 },
  });
}

const claudeUsageService = new ClaudeUsageService(() => ({
  scanInterval: vscode.workspace.getConfiguration('deepseek-balance').get<number>('claudeScanInterval', 10),
  modelPricing: getPricingConfig(),
}));

claudeUsageService.onDidUpdate((data) => {
  LOG('Claude usage updated: cost=' + data.totalCost.toFixed(2) + ' tokens=' + data.tokenStats.inputTokens);
  panelProvider.updateClaudeUsage(data);
});
```

Add import at top: `import { ClaudeUsageService } from './claudeUsageService';`

- [ ] **Step 2: Start/stop claudeUsageService**

After `balanceService.start();` (line 85), add: `claudeUsageService.start();`

In the dispose block (around line 88), add claudeUsageService.stop():

```typescript
context.subscriptions.push({
  dispose: () => {
    balanceService.stop();
    claudeUsageService.stop();
    if (configTimer) { clearTimeout(configTimer); }
  },
});
```

- [ ] **Step 3: Update panelProvider constructor to handle claude data**

In `webviewProvider.ts`, add fields:

```typescript
private _lastClaudeUsage: import('./types').ClaudeUsageData | null = null;
private _isClaudeReady = false;
```

Add method:

```typescript
updateClaudeUsage(data: import('./types').ClaudeUsageData): void {
  this._lastClaudeUsage = data;
  if (!this._view) { return; }
  this._view.webview.postMessage({ command: 'claudeUpdate', data });
}
```

In the `resolveWebviewView` method, in the `onDidReceiveMessage` handler for `'ready'`, also replay claude data if available:

```typescript
if (msg.command === 'ready') {
  // ... existing code ...
  if (this._lastClaudeUsage) {
    this.updateClaudeUsage(this._lastClaudeUsage);
  }
}
```

- [ ] **Step 4: Update config change handler to restart claude service too**

In the config change handler in `extension.ts`, after `balanceService.restart()`, add:

```typescript
claudeUsageService.restart();
```

- [ ] **Step 5: Add manual refresh for Claude usage**

Register a new command or add to the existing refresh command. In the `'deepseek-balance.refresh'` handler, also trigger claude scan:

```typescript
await claudeUsageService.scan();
```

- [ ] **Step 6: Compile**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts src/webviewProvider.ts
git commit -m "feat: wire ClaudeUsageService to extension and webview"
```

---

### Task 5: Add configuration properties to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add new configuration properties**

In `package.json`, in `contributes.configuration.properties`, add after the `currency` property (after line 47):

```json
"deepseek-balance.modelPricing": {
  "type": "object",
  "default": {
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
  },
  "description": "Per-model pricing for cost calculation (CNY per million tokens)"
},
"deepseek-balance.claudeScanInterval": {
  "type": "number",
  "default": 10,
  "minimum": 5,
  "maximum": 120,
  "description": "Claude Code local JSONL scan interval in minutes"
}
```

- [ ] **Step 2: Compile**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors (config changes don't affect TS).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add modelPricing and claudeScanInterval config"
```

---

### Task 6: Update panel.js — Claude Code Usage UI section

**Files:**
- Modify: `media/panel.js`

- [ ] **Step 1: Add HTML structure for Claude module in webviewProvider.ts**

In `webviewProvider.ts`, in the `getHtml` method, add after the `</div>` that closes the stats div (after line 232):

```html
<!-- Claude Code Usage Section -->
<div class="section-divider"></div>
<div class="section-title">Claude Code Usage</div>

<div class="overview-grid">
  <div class="ov-item">
    <div class="ov-label">Total Tokens</div>
    <div class="ov-value" id="claudeTokens">--</div>
  </div>
  <div class="ov-item">
    <div class="ov-label">Est. Cost</div>
    <div class="ov-value" id="claudeCost">--</div>
  </div>
  <div class="ov-item">
    <div class="ov-label">API Calls</div>
    <div class="ov-value" id="claudeCalls">--</div>
  </div>
  <div class="ov-item">
    <div class="ov-label">Cache Hit Rate</div>
    <div class="ov-value" id="claudeCacheRate">--</div>
  </div>
</div>

<div class="chart-container" id="claudeChartContainer">
  <div class="chart-title">Token / Cost Trend (7 days)</div>
  <canvas id="claudeTrendChart"></canvas>
</div>

<div class="chart-container" id="pieChartContainer">
  <div class="chart-title">Model Distribution</div>
  <canvas id="modelPieChart"></canvas>
</div>

<div class="chart-container" id="topSessionsContainer">
  <div class="chart-title">Top Sessions (by cost)</div>
  <div id="topSessionsList"></div>
</div>

<div class="cost-projection" id="costProjection">
  <span>Projected this month: </span>
  <span id="projectedCost">--</span>
</div>

<div class="claude-actions">
  <button class="refresh-btn" id="claudeRefreshBtn">⟳ Scan Local Data</button>
  <button class="refresh-btn" id="exportBtn">📋 Export CSV</button>
  <span class="last-updated" id="claudeUpdatedAt"></span>
</div>
```

Add to the `<style>` block in the same HTML:

```css
.section-divider {
  border-top: 1px solid var(--vscode-widget-border);
  margin: 20px 0 16px;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}
.overview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.ov-item {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
  padding: 10px;
  text-align: center;
}
.ov-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
.ov-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
.cost-projection {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
  padding: 10px 14px;
  margin: 12px 0;
  font-size: 13px;
  text-align: center;
}
.claude-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
#topSessionsList {
  font-size: 12px;
}
#topSessionsList .session-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid var(--vscode-widget-border);
}
#topSessionsList .session-row:last-child { border-bottom: none; }
.refresh-hint {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  text-align: center;
  margin-top: 4px;
  opacity: 0;
  transition: opacity 0.3s;
}
.refresh-hint.visible { opacity: 1; }
```

- [ ] **Step 2: Add refreshHint message handler in panel.js**

At the top of the message handler (around line 174), add a case:

```javascript
} else if (msg.command === 'refreshHint') {
  var hint = document.getElementById('refreshHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'refreshHint';
    hint.className = 'refresh-hint';
    var card = el('balanceCard');
    if (card) { card.appendChild(hint); }
  }
  hint.textContent = msg.message;
  hint.classList.add('visible');
  setTimeout(function () { hint.classList.remove('visible'); }, 3000);
}
```

Also add a `<div class="refresh-hint" id="refreshHint"></div>` after the balance detail grid in the HTML (after line 207 in webviewProvider.ts).

- [ ] **Step 3: Add Claude update handler in panel.js**

Add after the existing message handlers in panel.js:

```javascript
} else if (msg.command === 'claudeUpdate') {
  renderClaudeModule(msg.data);
}
```

- [ ] **Step 4: Implement renderClaudeModule function**

Add to panel.js:

```javascript
function fmtNum(n) {
  if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
  if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'K'; }
  return n.toString();
}

function renderClaudeModule(data) {
  // Overview cards
  var totalTok = data.tokenStats.inputTokens + data.tokenStats.outputTokens + data.tokenStats.cacheReadTokens;
  el('claudeTokens').textContent = fmtNum(totalTok);
  el('claudeCost').textContent = '¥' + data.totalCost.toFixed(2);
  el('claudeCalls').textContent = fmtNum(data.callCount);
  el('cacheHitRate').textContent = (data.cacheHitRate * 100).toFixed(1) + '%';
  el('projectedCost').textContent = '¥' + data.projectedMonthlyCost.toFixed(2);

  // Trend chart
  drawClaudeTrend(data.dailyStats);

  // Pie chart
  drawModelPie(data.modelUsage);

  // Top sessions
  renderTopSessions(data.topSessions);

  // Timestamp
  if (el('claudeUpdatedAt')) {
    el('claudeUpdatedAt').textContent = 'last scanned ' + formatUpdatedAt(Date.now());
  }
}
```

- [ ] **Step 5: Implement drawClaudeTrend (token + cost dual-axis line chart)**

```javascript
function drawClaudeTrend(dailyStats) {
  var container = el('claudeChartContainer');
  var canvas = el('claudeTrendChart');
  if (!canvas || !container || dailyStats.length === 0) { return; }

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24;
  if (w < 80) { w = 80; }
  var h = 200;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var tokenValues = dailyStats.map(function (d) { return d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens; });
  var costValues = dailyStats.map(function (d) { return d.cost; });

  var maxToken = Math.max.apply(null, tokenValues) || 1;
  var maxCost = Math.max.apply(null, costValues) || 1;

  var M = { top: 10, right: 50, bottom: 24, left: 50 };
  var plotW = w - M.left - M.right;
  var plotH = h - M.top - M.bottom;
  if (plotW < 20) { plotW = 20; }

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(128,128,128,0.12)';
  ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var yPos = M.top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(M.left, yPos);
    ctx.lineTo(w - M.right, yPos);
    ctx.stroke();
  }

  // Left Y axis (tokens)
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    var val = maxToken * (4 - i) / 4;
    var yPos = M.top + plotH * i / 4;
    ctx.fillText(fmtNum(val), M.left - 6, yPos);
  }

  // Right Y axis (cost)
  ctx.textAlign = 'left';
  for (var i = 0; i <= 4; i++) {
    var val = maxCost * (4 - i) / 4;
    var yPos = M.top + plotH * i / 4;
    ctx.fillText('¥' + val.toFixed(2), w - M.right + 4, yPos);
  }

  function xPos(i) { return M.left + plotW * i / Math.max(1, dailyStats.length - 1); }

  // Token line (blue)
  ctx.beginPath();
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 2;
  ctx.moveTo(xPos(0), M.top + plotH - plotH * tokenValues[0] / maxToken);
  for (var k = 1; k < dailyStats.length; k++) {
    ctx.lineTo(xPos(k), M.top + plotH - plotH * tokenValues[k] / maxToken);
  }
  ctx.stroke();

  // Cost line (green)
  ctx.beginPath();
  ctx.strokeStyle = '#81c784';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.moveTo(xPos(0), M.top + plotH - plotH * costValues[0] / maxCost);
  for (var k = 1; k < dailyStats.length; k++) {
    ctx.lineTo(xPos(k), M.top + plotH - plotH * costValues[k] / maxCost);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Legend
  ctx.font = '10px sans-serif';
  var legendY = M.top + plotH + 16;
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(M.left, legendY - 4, 10, 10);
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'left';
  ctx.fillText('Tokens', M.left + 14, legendY);
  ctx.fillStyle = '#81c784';
  ctx.fillRect(M.left + 60, legendY - 4, 10, 10);
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.fillText('Cost (¥)', M.left + 74, legendY);

  // X labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  var maxLabels = Math.min(dailyStats.length, 6);
  var step = Math.max(1, Math.ceil(dailyStats.length / maxLabels));
  for (var j = 0; j < dailyStats.length; j += step) {
    var label = dailyStats[j].date.slice(5); // MM-DD
    var x = xPos(j);
    ctx.fillText(label, x, M.top + plotH + 20);
  }
}
```

- [ ] **Step 6: Implement drawModelPie (pie chart)**

```javascript
function drawModelPie(modelUsage) {
  var container = el('pieChartContainer');
  var canvas = el('modelPieChart');
  if (!canvas || !container || modelUsage.length === 0) { return; }

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24;
  if (w < 80) { w = 80; }
  var h = 200;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var colors = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1'];
  var totalCost = 0;
  for (var i = 0; i < modelUsage.length; i++) { totalCost += modelUsage[i].cost; }

  var cx = w * 0.35;
  var cy = h * 0.5;
  var radius = Math.min(cx - 10, cy - 10, 70);

  // Draw arcs
  var startAngle = -Math.PI / 2;
  for (var i = 0; i < modelUsage.length; i++) {
    var sliceAngle = (modelUsage[i].cost / totalCost) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
    ctx.lineWidth = 2;
    ctx.stroke();
    startAngle += sliceAngle;
  }

  // Legend
  var legendX = cx + radius + 16;
  var legendY = cy - (modelUsage.length * 18) / 2;
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  for (var i = 0; i < modelUsage.length; i++) {
    var y = legendY + i * 20;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(legendX, y - 5, 10, 10);
    ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
    ctx.textAlign = 'left';
    var pct = ((modelUsage[i].cost / totalCost) * 100).toFixed(0);
    ctx.fillText(modelUsage[i].model + ' (' + pct + '%)', legendX + 14, y);
  }
}
```

- [ ] **Step 7: Implement renderTopSessions**

```javascript
function renderTopSessions(sessions) {
  var list = el('topSessionsList');
  if (!list) { return; }
  var html = '';
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var cost = 0;
    var tokens = s.tokenStats.inputTokens + s.tokenStats.outputTokens + s.tokenStats.cacheReadTokens;
    for (var j = 0; j < s.modelUsage.length; j++) { cost += s.modelUsage[j].cost; }
    var shortId = s.sessionId.substring(0, 8);
    var shortProject = s.projectDir;
    // Truncate project dir
    if (shortProject.length > 20) { shortProject = '...' + shortProject.slice(-17); }
    html += '<div class="session-row">' +
      '<span>' + shortProject + ' / ' + shortId + ' (' + s.messageCount + ' msgs)</span>' +
      '<span>¥' + cost.toFixed(2) + ' | ' + fmtNum(tokens) + ' tok</span>' +
      '</div>';
  }
  list.innerHTML = html;
}
```

- [ ] **Step 8: Add Claude refresh and export button handlers in panel.js**

Add at the bottom of panel.js (before the ready signal):

```javascript
// Claude refresh button
var claudeBtn = el('claudeRefreshBtn');
if (claudeBtn) {
  claudeBtn.addEventListener('click', function () {
    vscode.postMessage({ command: 'claudeRefresh' });
  });
}

// Export button
var exportBtn = el('exportBtn');
if (exportBtn) {
  exportBtn.addEventListener('click', function () {
    vscode.postMessage({ command: 'exportCSV' });
  });
}
```

- [ ] **Step 9: Handle export and claudeRefresh messages in webviewProvider**

Add to `onDidReceiveMessage` in `webviewProvider.ts`:

```typescript
} else if (msg.command === 'claudeRefresh') {
  LOG('Webview requested Claude refresh');
  vscode.commands.executeCommand('deepseek-balance.claudeRefresh');
} else if (msg.command === 'exportCSV') {
  LOG('Webview requested CSV export');
  vscode.commands.executeCommand('deepseek-balance.exportCSV');
}
```

- [ ] **Step 10: Register new commands + export logic in extension.ts**

Add command registrations in `extension.ts`:

```typescript
// Claude refresh command
context.subscriptions.push(
  vscode.commands.registerCommand('deepseek-balance.claudeRefresh', async () => {
    LOG('Manual Claude scan triggered');
    await claudeUsageService.scan();
  })
);

// Export CSV command
context.subscriptions.push(
  vscode.commands.registerCommand('deepseek-balance.exportCSV', async () => {
    const data = (claudeUsageService as any)._lastData as import('./types').ClaudeUsageData | undefined;
    if (!data) {
      vscode.window.showWarningMessage('No Claude usage data to export yet.');
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('claude-usage.csv'),
      filters: { 'CSV': ['csv'], 'All Files': ['*'] },
    });
    if (!uri) { return; }
    const lines = ['date,tokens,cost,calls'];
    for (const d of data.dailyStats) {
      const total = d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
      lines.push(`${d.date},${total},${d.cost.toFixed(4)},${d.callCount}`);
    }
    fs.writeFileSync(uri.fsPath, lines.join('\n'), 'utf-8');
    vscode.window.showInformationMessage('Exported to ' + uri.fsPath);
  })
);
```

Add `import * as fs from 'fs';` at the top of `extension.ts`.

Also store last claude data in panelProvider so it can be queried for export. In `webviewProvider.ts`, update `updateClaudeUsage` to also store the raw data:

```typescript
private _claudeData: import('./types').ClaudeUsageData | null = null;

updateClaudeUsage(data: import('./types').ClaudeUsageData): void {
  this._claudeData = data;
  if (!this._view) { return; }
  this._view.webview.postMessage({ command: 'claudeUpdate', data });
}

getClaudeData(): import('./types').ClaudeUsageData | null {
  return this._claudeData;
}
```

Update extension.ts export handler to use `panelProvider.getClaudeData()` instead of the cast.

- [ ] **Step 11: Add export command to package.json contributes**

In `package.json`, in `contributes.commands`, add:

```json
{
  "command": "deepseek-balance.claudeRefresh",
  "title": "Refresh Claude Code Usage"
},
{
  "command": "deepseek-balance.exportCSV",
  "title": "Export Usage CSV"
}
```

- [ ] **Step 12: Compile and fix any errors**

Run: `cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor" && npm run compile`
Expected: Compiles without errors.

- [ ] **Step 13: Commit**

```bash
git add media/panel.js src/webviewProvider.ts src/extension.ts package.json
git commit -m "feat: add Claude Code usage UI with charts, export, and refresh hint"
```

---

### Task 7: Build VSIX, verify

**Files:**
- None (verify only)

- [ ] **Step 1: Build the VSIX**

Run:
```powershell
cd "d:\桌面\清华大学\chajian\deepseek-balance-monitor"
npm run compile
npx vsce package --allow-star-activation --allow-missing-repository
```
Expected: VSIX created without errors.

- [ ] **Step 2: Verification checklist**

- [ ] Balance card still shows correctly
- [ ] Manual refresh with unchanged balance shows hint text, auto-dismisses
- [ ] Claude overview cards show data (numbers not "--")
- [ ] Trend chart renders token + cost lines
- [ ] Pie chart renders model distribution
- [ ] Top sessions list shows entries
- [ ] Monthly projection shows a value
- [ ] Export CSV produces valid file
- [ ] Config changes reload correctly

- [ ] **Step 3: Commit VSIX if desired**

```bash
git add deepseek-balance-monitor-*.vsix
git commit -m "build: update VSIX package"
```

---

## Plan Notes

- The ClaudeUsageService uses `fs.createReadStream` with `start` offset for incremental reads. The offset tracking is per-file in a Map.
- Session-level model usage is re-computed in `computeUsage` for sessions only — could be optimized but the JSONL parser already holds all messages in memory. For very large histories (>10k messages), future optimization could store pre-computed session aggregates.
- All charts use Canvas 2D API with manual drawing, matching the existing chart style in panel.js.
- The refresh hint auto-dismisses after 3 seconds via CSS opacity transition.

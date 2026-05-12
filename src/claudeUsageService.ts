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
  private isScanning = false;

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
    this.isScanning = false;
  }

  restart(): void {
    this.isScanning = false;
    this.stop();
    this.start();
  }

  /**
   * Scan local JSONL files and compute usage.
   * @param forceFull — if true, clear all cached data and re-read every file from scratch
   * @returns true if scan executed, false if skipped (already scanning)
   */
  async scan(forceFull = false): Promise<boolean> {
    if (this.isScanning) { return false; }
    this.isScanning = true;
    try {
      if (forceFull) {
        this.lastOffsets.clear();
        this.parsedMessages.clear();
      }

      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      if (!fs.existsSync(projectsDir)) {
        const data = this.computeUsage();
        this._onDidUpdate.fire(data);
        return true;
      }

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
          const lastOffset = this.lastOffsets.get(key) || 0;
          if (lastOffset > 0) {
            await this.readLines(filePath, lastOffset, key, dir);
          } else {
            await this.readLines(filePath, 0, key, dir);
          }
          this.lastOffsets.set(key, fs.statSync(filePath).size);
        }
      }

      const data = this.computeUsage();
      this._onDidUpdate.fire(data);
      return true;
    } finally {
      this.isScanning = false;
    }
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
    const defaultPricing: ModelPricing = { inputPerMTok: 3.0, cacheHitPerMTok: 0.025, cacheCreatePerMTok: 3.0, outputPerMTok: 6.0 };

    const modelMap = new Map<string, { stats: TokenStats; count: number }>();
    const sessionMap = new Map<string, SessionUsage>();
    const dailyMap = new Map<string, { stats: TokenStats; count: number; models: Record<string, TokenStats> }>();
    let globalStats: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    let callCount = 0;

    const sessionMessages = new Map<string, any[]>();

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

        // Group messages by sessionId for per-session model usage later
        let smsgs = sessionMessages.get(sid);
        if (!smsgs) { smsgs = []; sessionMessages.set(sid, smsgs); }
        smsgs.push(msg);

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
        (m.stats.cacheCreateTokens / 1_000_000) * p.cacheCreatePerMTok +
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
          (ts.cacheCreateTokens / 1_000_000) * p.cacheCreatePerMTok +
          (ts.outputTokens / 1_000_000) * p.outputPerMTok;
      }
      dailyStats.push({ date, tokenStats: d.stats, cost, callCount: d.count, models: d.models });
    }
    dailyStats.sort((a, b) => a.date.localeCompare(b.date));

    // Top sessions (by cost) — compute per-session model usage + cost
    const sessions: SessionUsage[] = [];
    for (const [, s] of sessionMap) {
      const smModels = new Map<string, { stats: TokenStats; count: number }>();
      for (const msg of (sessionMessages.get(s.sessionId) || [])) {
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
          (m.stats.cacheCreateTokens / 1_000_000) * p.cacheCreatePerMTok +
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

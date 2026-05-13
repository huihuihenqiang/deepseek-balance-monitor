import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import {
  TokenStats, ModelPricing, ModelUsage, SessionUsage,
  DailyStats, ClaudeUsageData, ProjectUsage, HourlyStats, TodayCallDetail
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
  const d = new Date(ts);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

export class ClaudeUsageService {
  private _onDidUpdate = new vscode.EventEmitter<ClaudeUsageData>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private timer: NodeJS.Timeout | null = null;
  private lastOffsets: Map<string, number> = new Map();
  private parsedMessages: Map<string, any[]> = new Map(); // sessionId -> messages
  private projectPaths: Map<string, string> = new Map(); // encoded dir -> actual path
  private isScanning = false;
  private _scanDebug = '';

  constructor(
    private getConfig: () => { scanInterval: number }
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
      this._scanDebug = 'dir=' + projectsDir + ' exists=' + fs.existsSync(projectsDir);
      console.log('[DeepSeek Balance] scan: ' + this._scanDebug);
      if (!fs.existsSync(projectsDir)) {
        const data = this.computeUsage();
        data.debugInfo = this._scanDebug + ' (DIR_NOT_FOUND)';
        this._onDidUpdate.fire(data);
        return true;
      }

      const projectDirs = fs.readdirSync(projectsDir).filter(d => {
        const full = path.join(projectsDir, d);
        return fs.statSync(full).isDirectory();
      });

      this._scanDebug += ' | projectDirs=' + projectDirs.length;
      console.log('[DeepSeek Balance] scan: found ' + projectDirs.length + ' project dirs');

      let totalFiles = 0;
      for (const dir of projectDirs) {
        const projectPath = path.join(projectsDir, dir);
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        totalFiles += files.length;
        console.log('[DeepSeek Balance] scan: dir=' + dir + ' files=' + files.length);
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

      this._scanDebug += ' | jsonlFiles=' + totalFiles;
      const data = this.computeUsage();
      data.debugInfo = this._scanDebug + ' | ' + (data.debugInfo || '');
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
          // Extract actual project path if available
          if (!this.projectPaths.has(projectDir) && obj.cwd) {
            this.projectPaths.set(projectDir, obj.cwd);
          }
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
    // Default pricing for internal cost calculation (not displayed in UI)
    const defaultPricing: ModelPricing = { inputPerMTok: 3.0, cacheHitPerMTok: 0.025, cacheCreatePerMTok: 3.0, outputPerMTok: 6.0 };
    const pricing: Record<string, ModelPricing> = {};

    const modelMap = new Map<string, { stats: TokenStats; count: number }>();
    const sessionMap = new Map<string, SessionUsage>();
    const projectMap = new Map<string, { stats: TokenStats; callCount: number; messageCount: number }>();
    const dailyMap = new Map<string, { stats: TokenStats; count: number; models: Record<string, TokenStats> }>();
    const todayHourlyMap = new Map<number, { tokens: number; calls: number; inputTokens: number; cacheReadTokens: number }>();
    const yesterdayHourlyMap = new Map<number, { tokens: number; calls: number; inputTokens: number; cacheReadTokens: number }>();
    const todayCallList: TodayCallDetail[] = [];
    const todayStr = formatDate(Date.now());
    const yesterdayStr = formatDate(Date.now() - 86400000);
    let globalStats: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    let callCount = 0;

    // DEBUG: log what we're working with
    let totalMessages = 0;
    let assistantMessages = 0;
    for (const [, messages] of this.parsedMessages) {
      totalMessages += messages.length;
      for (const msg of messages) {
        const m = msg.message;
        if (m && m.role === 'assistant' && m.usage) { assistantMessages++; }
      }
    }
    console.log('[DeepSeek Balance] computeUsage: parsedMessages entries=' + this.parsedMessages.size +
      ' totalMessages=' + totalMessages + ' assistantMsgs=' + assistantMessages);

    const sessionMessages = new Map<string, any[]>();

    for (const [, messages] of this.parsedMessages) {
      for (const msg of messages) {
        // Actual data is nested in msg.message (Claude Code session format)
        const m = msg.message;
        if (!m || m.role !== 'assistant' || !m.usage) { continue; }
        const usage = m.usage;
        const model = m.model || 'unknown';
        const ts = new Date(msg.timestamp).getTime();
        if (!Number.isFinite(ts)) { continue; }
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

        // Per project
        const projDir = msg._projectDir || 'unknown';
        let pp = projectMap.get(projDir);
        if (!pp) { pp = { stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, callCount: 0, messageCount: 0 }; projectMap.set(projDir, pp); }
        pp.stats.inputTokens += usage.input_tokens || 0;
        pp.stats.outputTokens += usage.output_tokens || 0;
        pp.stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        pp.stats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
        pp.callCount++;
        pp.messageCount++;

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
            startedAt: ts,
            lastActiveAt: ts,
          };
          sessionMap.set(sid, ss);
        }
        ss.tokenStats.inputTokens += usage.input_tokens || 0;
        ss.tokenStats.outputTokens += usage.output_tokens || 0;
        ss.tokenStats.cacheReadTokens += usage.cache_read_input_tokens || 0;
        ss.tokenStats.cacheCreateTokens += usage.cache_creation_input_tokens || 0;
        ss.messageCount++;
        if (ts < ss.startedAt) { ss.startedAt = ts; }
        if (ts > ss.lastActiveAt) { ss.lastActiveAt = ts; }

        // Per day
        const date = formatDate(ts);
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

        // Per hour and per-call tracking (for today tab)
        const hour = new Date(ts).getHours();
        const totalToks = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0);
        if (date === todayStr) {
          let hh = todayHourlyMap.get(hour);
          if (!hh) { hh = { tokens: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0 }; todayHourlyMap.set(hour, hh); }
          hh.tokens += totalToks;
          hh.calls++;
          hh.inputTokens += usage.input_tokens || 0;
          hh.cacheReadTokens += usage.cache_read_input_tokens || 0;

          const totalInput = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          const projMatch = projDir.match(/^[A-Za-z]-+(.+)$/);
          todayCallList.push({
            time: String(new Date(ts).getHours()).padStart(2, '0') + ':' + String(new Date(ts).getMinutes()).padStart(2, '0'),
            projectName: projMatch ? projMatch[1] : projDir,
            model: model,
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreateTokens: usage.cache_creation_input_tokens || 0,
            totalTokens: totalToks,
            cacheHitRate: totalInput > 0 ? (usage.cache_read_input_tokens || 0) / totalInput : 0,
          });
        }
        if (date === yesterdayStr) {
          let yh = yesterdayHourlyMap.get(hour);
          if (!yh) { yh = { tokens: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0 }; yesterdayHourlyMap.set(hour, yh); }
          yh.tokens += totalToks;
          yh.calls++;
          yh.inputTokens += usage.input_tokens || 0;
          yh.cacheReadTokens += usage.cache_read_input_tokens || 0;
        }
      }
    }

    // Compute model usage with cost
    // Filter out internal/synthetic models
    function isRealModel(name: string): boolean {
      return !!name && name !== '<synthetic>' && !name.startsWith('<');
    }

    const modelUsage: ModelUsage[] = [];
    for (const [model, m] of modelMap) {
      if (!isRealModel(model)) { continue; }
      const p = pricing[model] || defaultPricing;
      const cost =
        (m.stats.inputTokens / 1_000_000) * p.inputPerMTok +
        (m.stats.cacheReadTokens / 1_000_000) * p.cacheHitPerMTok +
        (m.stats.cacheCreateTokens / 1_000_000) * p.cacheCreatePerMTok +
        (m.stats.outputTokens / 1_000_000) * p.outputPerMTok;
      modelUsage.push({ model, ...m.stats, callCount: m.count, cost });
    }
    modelUsage.sort((a, b) => b.cost - a.cost);

    // Compute total cost (only for real models)
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
        const m = msg.message;
        if (!m || m.role !== 'assistant' || !m.usage) { continue; }
        const model = m.model || 'unknown';
        let sm = smModels.get(model);
        if (!sm) { sm = { stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, count: 0 }; smModels.set(model, sm); }
        sm.stats.inputTokens += m.usage.input_tokens || 0;
        sm.stats.outputTokens += m.usage.output_tokens || 0;
        sm.stats.cacheReadTokens += m.usage.cache_read_input_tokens || 0;
        sm.stats.cacheCreateTokens += m.usage.cache_creation_input_tokens || 0;
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

    const now = new Date();
    const monthKey = formatDate(now.getTime()).slice(0, 7);
    const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const minutesIntoDay = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const dayFraction = Math.max(0.25, Math.min(1, minutesIntoDay / 1440));
    const elapsedMonthDays = Math.min(daysInCurrentMonth, (now.getDate() - 1) + dayFraction);

    let monthToDateCost = 0;
    let monthToDateTokens = 0;
    for (const d of dailyStats) {
      if (!d.date.startsWith(monthKey)) { continue; }
      monthToDateCost += d.cost;
      monthToDateTokens += d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
    }

    const projectedMonthlyCost = elapsedMonthDays > 0
      ? (monthToDateCost / elapsedMonthDays) * daysInCurrentMonth
      : 0;
    const projectedMonthlyTokens = elapsedMonthDays > 0
      ? (monthToDateTokens / elapsedMonthDays) * daysInCurrentMonth
      : 0;

    // Project-based ranking (by total tokens)
    const topProjects: ProjectUsage[] = [];
    for (const [projDir, p] of projectMap) {
      topProjects.push({
        projectDir: projDir,
        tokenStats: p.stats,
        callCount: p.callCount,
        messageCount: p.messageCount,
        projectPath: this.projectPaths.get(projDir),
      });
    }
    topProjects.sort((a, b) => {
      const aTotal = a.tokenStats.inputTokens + a.tokenStats.outputTokens + a.tokenStats.cacheReadTokens;
      const bTotal = b.tokenStats.inputTokens + b.tokenStats.outputTokens + b.tokenStats.cacheReadTokens;
      return bTotal - aTotal;
    });

    // Today hourly breakdown
    const todayHourly: HourlyStats[] = [];
    for (let h = 0; h < 24; h++) {
      const hh = todayHourlyMap.get(h);
      const totalInput = (hh ? hh.inputTokens : 0) + (hh ? hh.cacheReadTokens : 0);
      todayHourly.push({
        hour: h,
        tokens: hh ? hh.tokens : 0,
        calls: hh ? hh.calls : 0,
        cacheHitRate: totalInput > 0 ? (hh ? hh.cacheReadTokens : 0) / totalInput : 0,
      });
    }

    // Yesterday hourly breakdown
    const yesterdayHourly: HourlyStats[] = [];
    for (let h = 0; h < 24; h++) {
      const yh = yesterdayHourlyMap.get(h);
      const totalInput = (yh ? yh.inputTokens : 0) + (yh ? yh.cacheReadTokens : 0);
      yesterdayHourly.push({
        hour: h,
        tokens: yh ? yh.tokens : 0,
        calls: yh ? yh.calls : 0,
        cacheHitRate: totalInput > 0 ? (yh ? yh.cacheReadTokens : 0) / totalInput : 0,
      });
    }

    // Top 10 heaviest calls today
    todayCallList.sort((a, b) => b.totalTokens - a.totalTokens);
    const todayCallDetails = todayCallList.slice(0, 10);

    const debugInfo = 'entries=' + this.parsedMessages.size +
      ' totalMsgs=' + totalMessages +
      ' assistantMsgs=' + assistantMessages +
      ' models=' + modelUsage.length + '(' + modelUsage.map(m => m.model).join(',') + ')' +
      ' sessions=' + sessionMap.size +
      ' projects=' + projectMap.size +
      ' days=' + dailyStats.length;

    return {
      tokenStats: globalStats,
      totalCost,
      callCount,
      cacheHitRate: Math.round(cacheHitRate * 10000) / 10000,
      modelUsage,
      dailyStats,
      todayHourly,
      yesterdayHourly,
      todayCallDetails,
      topSessions,
      topProjects,
      projectedMonthlyCost,
      projectedMonthlyTokens,
      debugInfo,
    };
  }
}

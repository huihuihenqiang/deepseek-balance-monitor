export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface BalanceResponse {
  isAvailable: boolean;
  balanceInfos: BalanceInfo[];
}

export interface Snapshot extends BalanceInfo {
  timestamp: number;
}

export interface BalanceStats {
  last1h: number;
  last24h: number;
  last7d: number;
  totalConsumed: number;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface ModelPricing {
  inputPerMTok: number;
  cacheHitPerMTok: number;
  cacheCreatePerMTok: number;
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

export interface ProjectUsage {
  projectDir: string;
  tokenStats: TokenStats;
  callCount: number;
  messageCount: number;
  projectPath?: string; // actual filesystem path, if found
}

export interface ClaudeUsageData {
  tokenStats: TokenStats;
  totalCost: number;
  callCount: number;
  cacheHitRate: number;
  modelUsage: ModelUsage[];
  dailyStats: DailyStats[];
  todayHourly: HourlyStats[];
  yesterdayHourly: HourlyStats[];
  todayCallDetails: TodayCallDetail[];
  topSessions: SessionUsage[];
  topProjects: ProjectUsage[];
  projectedMonthlyCost: number;
  projectedMonthlyTokens: number;
  debugInfo?: string;
}

export interface HourlyStats {
  hour: number; // 0-23
  tokens: number;
  calls: number;
  cacheHitRate: number;
}

export interface TodayCallDetail {
  time: string; // "15:32"
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  cacheHitRate: number;
}

export interface RefreshHint {
  show: boolean;
  message: string;
}

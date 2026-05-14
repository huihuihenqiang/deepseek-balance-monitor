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

export type PetState =
  | 'idle'
  | 'running'
  | 'running-left'
  | 'running-right'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'review'
  | 'waiting';

export interface PetBubble {
  text: string;
  tone: 'neutral' | 'ok' | 'warning' | 'danger';
}

export interface PetMetricsSnapshot {
  todayTokens: number;
  todayCalls: number;
  sevenDayAverageTokens: number;
  topProject?: string;
  monthToDateTokens: number;
  projectedMonthlyTokens: number;
  monthlyTokenBudget: number;
  lastInteractionAt: number;
}

export type PetCatalogSource =
  | 'builtin'
  | 'downloaded'
  | 'imported'
  | 'local-app'
  | 'local-codex'
  | 'local-petdex'
  | 'remote';

export interface PetCatalogEntry {
  slug: string;
  displayName: string;
  description?: string;
  source: PetCatalogSource;
  bundled?: boolean;
}

export type PetInteractionType =
  | 'hover'
  | 'tap'
  | 'double-tap'
  | 'drag-start'
  | 'drag-move'
  | 'drag-end'
  | 'hold-start'
  | 'hold-complete'
  | 'chat-open'
  | 'chat-close';

export interface PetInteractionEvent {
  type: PetInteractionType;
  direction?: 'left' | 'right' | 'center';
  screenX?: number;
  screenY?: number;
}

export interface PetPromptContext {
  todayTokens: number;
  todayCalls: number;
  topProject?: string;
  budgetStatus: string;
}

export interface PetEventState {
  id: string;
  state: PetState;
  bubble: PetBubble;
  expiresAt: number;
}

export interface PetCommandMessage {
  type: 'pet-update';
  state: PetState;
  bubble: PetBubble;
  metrics: PetMetricsSnapshot;
  updatedAt: number;
}

export interface PetChatRequest {
  message: string;
}

export interface PetChatSession {
  active: boolean;
  openedAt: number;
  latestReply: string;
}

export interface PetRuntimeStatus {
  enabled: boolean;
  status: 'stopped' | 'starting' | 'downloading' | 'running' | 'error';
  message: string;
}

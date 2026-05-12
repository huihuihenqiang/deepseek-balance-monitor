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

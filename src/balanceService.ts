import * as vscode from 'vscode';
import * as https from 'https';
import { BalanceResponse, BalanceInfo, Snapshot } from './types';
import { HistoryStore } from './historyStore';

export class BalanceService {
  private timer: NodeJS.Timeout | null = null;
  private _onDidUpdate = new vscode.EventEmitter<{
    balance: BalanceInfo;
    previousBalance: BalanceInfo | null;
    error?: string;
  }>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private lastBalance: BalanceInfo | null = null;
  private isFetching = false;

  constructor(
    private historyStore: HistoryStore,
    private getConfig: () => { apiKey: string; refreshInterval: number; currency: string }
  ) {}

  start(): void {
    this.fetch();
    this.startTimer();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    const interval = this.getConfig().refreshInterval * 60 * 1000;
    this.timer = setInterval(() => this.fetch(), interval);
  }

  async fetch(): Promise<void> {
    if (this.isFetching) {
      return;
    }
    this.isFetching = true;

    try {
      const config = this.getConfig();
      if (!config.apiKey) {
        this._onDidUpdate.fire({
          balance: { currency: '', totalBalance: '0', grantedBalance: '0', toppedUpBalance: '0' },
          previousBalance: null,
          error: 'no-api-key',
        });
        return;
      }

      const data = await this.httpGet(config.apiKey);
      const currency = config.currency === 'auto' ? data.balanceInfos[0]?.currency || 'CNY' : config.currency;
      const info = data.balanceInfos.find((b) => b.currency === currency) || data.balanceInfos[0];

      if (!info) {
        throw new Error('No balance data returned');
      }

      const balance: BalanceInfo = { ...info };
      const snapshot: Snapshot = { ...balance, timestamp: Date.now() };
      this.historyStore.addSnapshot(snapshot);

      this._onDidUpdate.fire({ balance, previousBalance: this.lastBalance });
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

  private httpGet(apiKey: string): Promise<BalanceResponse> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.deepseek.com',
          path: '/user/balance',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(body);
                resolve({
                  isAvailable: json.is_available,
                  balanceInfos: (json.balance_infos || []).map((b: any) => ({
                    currency: b.currency,
                    totalBalance: b.total_balance,
                    grantedBalance: b.granted_balance,
                    toppedUpBalance: b.topped_up_balance,
                  })),
                });
              } catch (e) {
                reject(new Error('Failed to parse balance response'));
              }
            } else if (res.statusCode === 401) {
              const err: any = new Error('Invalid API key');
              err.statusCode = 401;
              reject(err);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }
}

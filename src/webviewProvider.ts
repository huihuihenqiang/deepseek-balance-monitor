import * as vscode from 'vscode';
import { Snapshot, BalanceStats } from './types';

const LOG = (msg: string) => console.log('[DeepSeek Balance:Panel] ' + msg);

export class BalancePanelProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _lastBalance: { currency: string; total: string; granted: string; toppedUp: string } | null = null;
  private _lastError: string | null = null;
  private _lastClaudeUsage: import('./types').ClaudeUsageData | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private getSnapshots: () => Snapshot[],
    private getStats: () => BalanceStats
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    LOG('Webview resolving...');
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'refresh') {
        LOG('Webview requested refresh');
        vscode.commands.executeCommand('deepseek-balance.refresh');
      } else if (msg.command === 'ready') {
        LOG('Webview ready signal received');
        if (this._lastError) {
          this.showError(this._lastError);
        } else if (this._lastBalance) {
          LOG('Replaying cached balance to webview');
          this.update(this._lastBalance);
        }
        if (this._lastClaudeUsage) {
          this.updateClaudeUsage(this._lastClaudeUsage);
        }
      }
    });

    // If webview was opened after data was already fetched, push it now
    setTimeout(() => {
      if (this._lastBalance && this._view) {
        LOG('Delayed replay of cached balance');
        this.update(this._lastBalance);
      }
    }, 200);

    LOG('Webview resolved');
  }

  update(balance: { currency: string; total: string; granted: string; toppedUp: string }): void {
    if (!balance) {return;}
    this._lastBalance = balance;
    this._lastError = null;
    if (!this._view) {
      LOG('update: webview not ready, cached balance for later');
      return;
    }
    const snapshots = this.getSnapshots();
    const stats = this.getStats();
    LOG('update: pushing to webview, snapshots=' + snapshots.length);
    this._view.webview.postMessage({
      command: 'update',
      balance,
      snapshots,
      stats,
    });
  }

  showError(message: string): void {
    this._lastError = message;
    if (!this._view) {
      LOG('showError: webview not ready, cached error for later');
      return;
    }
    LOG('showError: pushing to webview');
    this._view.webview.postMessage({ command: 'error', message });
  }

  setRefreshing(active: boolean): void {
    if (!this._view) {return;}
    this._view.webview.postMessage({ command: 'refreshing', active });
  }

  showRefreshHint(): void {
    if (!this._view) { return; }
    this._view.webview.postMessage({ command: 'refreshHint', message: '余额未变化，可能官方数据未更新，请稍后再试' });
  }

  updateClaudeUsage(data: import('./types').ClaudeUsageData): void {
    console.log('[DeepSeek Balance:Panel] updateClaudeUsage: calls=' + data.callCount + ' hasView=' + !!this._view);
    this._lastClaudeUsage = data;
    if (!this._view) { return; }
    this._view.webview.postMessage({ command: 'claudeUpdate', data, timestamp: Date.now() });
  }

  private getHtml(webview: vscode.Webview): string {
    const panelJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Balance</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 16px;
      font-size: 13px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .refresh-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 12px;
    }
    .refresh-btn:hover { background: var(--vscode-button-hoverBackground); }
    .last-updated { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .balance-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 20px;
      text-align: center;
      margin-bottom: 16px;
    }
    .balance-label { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 4px; }
    .balance-value { font-size: 32px; font-weight: 700; }
    .balance-value.warning { color: var(--vscode-editorWarning-foreground); }
    .balance-value.danger { color: var(--vscode-errorForeground); }
    .balance-detail {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 12px;
    }
    .detail-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 8px;
    }
    .detail-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .detail-value { font-size: 16px; font-weight: 600; margin-top: 2px; }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 16px;
    }
    .stat-item { padding: 8px; }
    .stat-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .stat-value { font-size: 14px; font-weight: 600; }
    .chart-container {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 12px;
      margin-top: 16px;
    }
    .chart-title {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    canvas { width: 100%; height: 180px; display: block; }
    .error-banner {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground);
      padding: 10px 14px;
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 12px;
    }
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
  grid-template-columns: 1fr 1fr 1fr;
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

  </style>
</head>
<body>
  <div id="error" class="error-banner" style="display:none"></div>

  <div class="section-title">DeepSeek Usage</div>

  <div class="header">
    <span class="last-updated" id="updatedAt">Waiting for data...</span>
    <button class="refresh-btn" id="refreshBtn">⟳ Refresh</button>
  </div>

  <div class="balance-card" id="balanceCard">
    <div class="balance-label">Total Balance</div>
    <div class="balance-value" id="balanceTotal">--</div>
    <div class="balance-detail">
      <div class="detail-item">
        <div class="detail-label">Topped Up</div>
        <div class="detail-value" id="toppedUp">--</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Granted</div>
        <div class="detail-value" id="granted">--</div>
      </div>
    </div>
    <div class="refresh-hint" id="refreshHint"></div>
  </div>

  <div class="chart-container" id="chartContainer">
    <div class="chart-title">Balance Trend (7 days)</div>
    <canvas id="chart"></canvas>
  </div>

  <div class="stats" id="stats">
    <div class="stat-item">
      <div class="stat-label">Last 1 hour</div>
      <div class="stat-value" id="stat1h">--</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Last 24 hours</div>
      <div class="stat-value" id="stat24h">--</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Last 7 days</div>
      <div class="stat-value" id="stat7d">--</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Total Consumed</div>
      <div class="stat-value" id="statTotal">--</div>
    </div>
  </div>

  <!-- Claude Code Usage Section -->
  <div class="section-divider"></div>
  <div class="section-title">Claude Code Usage</div>

  <div class="overview-grid">
    <div class="ov-item">
      <div class="ov-label">Total Tokens</div>
      <div class="ov-value" id="claudeTokens">--</div>
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
    <div class="chart-title">Token Usage (7 days)</div>
    <canvas id="claudeTrendChart"></canvas>
  </div>

  <div class="chart-container" id="pieChartContainer">
    <div class="chart-title">Model Distribution</div>
    <canvas id="modelPieChart"></canvas>
  </div>

  <div class="chart-container" id="topSessionsContainer">
    <div class="chart-title">Project Ranking (by tokens)</div>
    <div id="topSessionsList"></div>
  </div>

  <div class="cost-projection" id="costProjection">
    <span>Projected this month: </span>
    <span id="projectedCost">--</span>
  </div>

  <div class="claude-actions">
    <span class="last-updated" id="claudeUpdatedAt"></span>
  </div>

  <div id="claudeDebug" style="display:none;margin-top:8px;padding:6px;background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);font-size:11px;font-family:monospace;white-space:pre-wrap;"></div>

  <script src="${panelJsUri}"></script>
</body>
</html>`;
  }
}

import * as vscode from 'vscode';
import { BalanceService } from './balanceService';
import { HistoryStore } from './historyStore';
import { BalancePanelProvider } from './webviewProvider';
import { ClaudeUsageService } from './claudeUsageService';
import * as fs from 'fs';

const LOG = (msg: string) => console.log('[DeepSeek Balance] ' + msg);

export function activate(context: vscode.ExtensionContext) {
  LOG('Extension activating...');
  const historyStore = new HistoryStore(context);

  function getConfig() {
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    return {
      apiKey: cfg.get<string>('apiKey', ''),
      refreshInterval: cfg.get<number>('refreshInterval', 30),
      currency: cfg.get<string>('currency', 'auto'),
    };
  }

  const config = getConfig();
  LOG('Config loaded: apiKey=' + (config.apiKey ? '***' : '<not set>') + ' interval=' + config.refreshInterval);

  const balanceService = new BalanceService(historyStore, getConfig);

  function getPricingConfig(): Record<string, import('./types').ModelPricing> {
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    return cfg.get<Record<string, import('./types').ModelPricing>>('modelPricing', {
      'deepseek-v4-pro': { inputPerMTok: 3.0, cacheHitPerMTok: 0.025, cacheCreatePerMTok: 3.0, outputPerMTok: 6.0 },
      'deepseek-v4-flash': { inputPerMTok: 1.0, cacheHitPerMTok: 0.02, cacheCreatePerMTok: 1.0, outputPerMTok: 2.0 },
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

  const panelProvider = new BalancePanelProvider(
    context.extensionUri,
    () => historyStore.getAll(),
    () => historyStore.getStats()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('deepseek-balance.panel', panelProvider)
  );

  balanceService.onDidUpdate(({ balance, error, balanceUnchanged }) => {
    LOG('Balance update: error=' + (error || 'none') + ' balance=' + (balance.totalBalance || 'none'));
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

  // Config change handler — debounced
  let configTimer: NodeJS.Timeout | null = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deepseek-balance')) {
        LOG('Config changed, scheduling restart...');
        if (configTimer) {clearTimeout(configTimer);}
        configTimer = setTimeout(() => {
          LOG('Restarting balance service...');
          balanceService.restart();
          claudeUsageService.restart();
        }, 1000);
      }
    })
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-balance.refresh', async () => {
      LOG('Manual refresh triggered');
      panelProvider.setRefreshing(true);
      await balanceService.fetchManual();
      await claudeUsageService.scan();
      panelProvider.setRefreshing(false);
    })
  );

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
      const data = panelProvider.getClaudeData();
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

  // Start polling
  LOG('Starting balance service...');
  balanceService.start();
  claudeUsageService.start();

  context.subscriptions.push({
    dispose: () => {
      balanceService.stop();
      claudeUsageService.stop();
      if (configTimer) {clearTimeout(configTimer);}
    },
  });

  LOG('Extension activated successfully');
}

export function deactivate() {}

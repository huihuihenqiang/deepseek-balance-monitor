import * as vscode from 'vscode';
import { BalanceService } from './balanceService';
import { HistoryStore } from './historyStore';
import { BalancePanelProvider } from './webviewProvider';

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

  const panelProvider = new BalancePanelProvider(
    context.extensionUri,
    () => historyStore.getAll(),
    () => historyStore.getStats()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('deepseek-balance.panel', panelProvider)
  );

  balanceService.onDidUpdate(({ balance, error }) => {
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
        }, 1000);
      }
    })
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-balance.refresh', async () => {
      LOG('Manual refresh triggered');
      panelProvider.setRefreshing(true);
      await balanceService.fetch();
      panelProvider.setRefreshing(false);
    })
  );

  // Start polling
  LOG('Starting balance service...');
  balanceService.start();

  context.subscriptions.push({
    dispose: () => {
      balanceService.stop();
      if (configTimer) {clearTimeout(configTimer);}
    },
  });

  LOG('Extension activated successfully');
}

export function deactivate() {}

import * as vscode from 'vscode';
import { BalanceService } from './balanceService';
import { HistoryStore } from './historyStore';
import { BalancePanelProvider } from './webviewProvider';
import { ClaudeUsageService } from './claudeUsageService';
import { PetController } from './petController';
import { ClaudeUsageData } from './types';

const LOG = (msg: string) => console.log('[DeepSeek Balance] ' + msg);

export function activate(context: vscode.ExtensionContext) {
  LOG('Extension activating...');
  const historyStore = new HistoryStore(context);

  function reportPetError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    LOG('Pet error: ' + message);
    vscode.window.showErrorMessage('AI Usage Pet: ' + message);
  }

  function getConfig() {
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    return {
      apiKey: cfg.get<string>('apiKey', ''),
      refreshInterval: cfg.get<number>('refreshInterval', 30),
      currency: cfg.get<string>('currency', 'auto'),
    };
  }

  function getPetConfig() {
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    return {
      enabled: cfg.get<boolean>('petEnabled', false),
      slug: cfg.get<string>('petSlug', 'anya-2'),
      apiKey: cfg.get<string>('apiKey', ''),
      chatBaseUrl: cfg.get<string>('petChatBaseUrl', 'https://api.deepseek.com/v1'),
      chatModel: cfg.get<string>('petChatModel', 'deepseek-v4-flash'),
      longPressUrl: cfg.get<string>('petLongPressUrl', 'https://www.bilibili.com'),
      monthlyTokenBudget: cfg.get<number>('monthlyTokenBudget', 0),
      proactiveChatEnabled: cfg.get<boolean>('petProactiveChatEnabled', true),
      proactiveChatMinMinutes: cfg.get<number>('petProactiveChatMinMinutes', 8),
      proactiveChatMaxMinutes: cfg.get<number>('petProactiveChatMaxMinutes', 18),
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

  const petController = new PetController(context, getPetConfig);
  let lastClaudeUsage: ClaudeUsageData | null = null;

  const claudeUsageService = new ClaudeUsageService(() => ({
    scanInterval: vscode.workspace.getConfiguration('deepseek-balance').get<number>('refreshInterval', 30),
  }));

  claudeUsageService.onDidUpdate((data) => {
    LOG('Claude usage updated: tokens=' + (data.tokenStats.inputTokens + data.tokenStats.outputTokens + data.tokenStats.cacheReadTokens));
    lastClaudeUsage = data;
    panelProvider.updateClaudeUsage(data);
    petController.updateFromUsage(data);
  });

  panelProvider.setPetStatus(petController.getStatus());
  context.subscriptions.push(
    petController.onDidChangeStatus((status) => panelProvider.setPetStatus(status))
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
      const affectsCore = [
        'apiKey',
        'refreshInterval',
        'currency',
        'lowBalanceThreshold',
        'lowDaysThreshold',
      ].some((key) => e.affectsConfiguration('deepseek-balance.' + key));
      const affectsPet = [
        'apiKey',
        'petEnabled',
        'petSlug',
        'petChatBaseUrl',
        'petChatModel',
        'petLongPressUrl',
        'monthlyTokenBudget',
        'petProactiveChatEnabled',
        'petProactiveChatMinMinutes',
        'petProactiveChatMaxMinutes',
      ].some((key) => e.affectsConfiguration('deepseek-balance.' + key));
      if (affectsCore || affectsPet) {
        LOG('Config changed, scheduling restart...');
        if (configTimer) {clearTimeout(configTimer);}
        configTimer = setTimeout(() => {
          if (affectsCore) {
            LOG('Restarting services...');
            balanceService.restart();
            claudeUsageService.restart();
            // Send updated config to webview
            const cfg = vscode.workspace.getConfiguration('deepseek-balance');
            panelProvider.postConfig({
              lowBalanceThreshold: cfg.get<number>('lowBalanceThreshold', 5),
              lowDaysThreshold: cfg.get<number>('lowDaysThreshold', 5),
            });
          }
          if (affectsPet || affectsCore) {
            void petController.syncWithConfiguration().then(() => {
              if (lastClaudeUsage) {
                petController.updateFromUsage(lastClaudeUsage);
              }
            }).catch(reportPetError);
          }
        }, 1000);
      }
    })
  );

  // Refresh command — refreshes both balance and Claude usage
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-balance.refresh', async () => {
      LOG('Manual refresh triggered');
      panelProvider.setRefreshing(true);
      await balanceService.fetchManual();
      await claudeUsageService.scan(true);
      if (lastClaudeUsage) {
        petController.showDailySummary(lastClaudeUsage);
      }
      panelProvider.setRefreshing(false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-balance.pet.toggle', async () => {
      try {
        await petController.toggle();
      } catch (err) {
        reportPetError(err);
      }
    }),
    vscode.commands.registerCommand('deepseek-balance.pet.show', async () => {
      try {
        await petController.setEnabled(true);
      } catch (err) {
        reportPetError(err);
      }
    }),
    vscode.commands.registerCommand('deepseek-balance.pet.hide', async () => {
      try {
        await petController.setEnabled(false);
      } catch (err) {
        reportPetError(err);
      }
    }),
    vscode.commands.registerCommand('deepseek-balance.pet.select', async () => {
      try {
        await petController.selectPet();
      } catch (err) {
        reportPetError(err);
      }
    }),
    vscode.commands.registerCommand('deepseek-balance.pet.importLocal', async () => {
      try {
        await petController.importLocalPet();
      } catch (err) {
        reportPetError(err);
      }
    })
  );

  // Start polling
  LOG('Starting services...');
  balanceService.start();
  claudeUsageService.start();
  void petController.syncWithConfiguration().catch((err) => {
    LOG('Pet startup failed: ' + (err instanceof Error ? err.message : String(err)));
  });

  context.subscriptions.push({
    dispose: () => {
      balanceService.stop();
      claudeUsageService.stop();
      petController.dispose();
      if (configTimer) {clearTimeout(configTimer);}
    },
  });

  LOG('Extension activated successfully');
}

export function deactivate() {}

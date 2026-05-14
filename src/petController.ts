import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { AddressInfo } from 'net';
import { BUILTIN_PET_CATALOG, slugifyPetName } from './petCatalog';
import { buildPetChatPrompt, buildPetProactivePrompt } from './petPrompts';
import {
  ClaudeUsageData,
  DailyStats,
  PetBubble,
  PetCatalogEntry,
  PetChatRequest,
  PetChatSession,
  PetCommandMessage,
  PetEventState,
  PetInteractionEvent,
  PetMetricsSnapshot,
  PetPromptContext,
  PetRuntimeStatus,
  PetState,
} from './types';

const LOG = (msg: string) => console.log('[AI Usage Pet] ' + msg);

const DEFAULT_PET_SLUG = 'anya-2';
const PET_MANIFEST_URL = 'https://petdex.crafter.run/api/manifest';
const EVENT_TTL_MS = 7000;
const CHAT_ERROR_TTL_MS = 2000;
const EVENT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const CHAT_RESPONSE_LIMIT = 1024 * 1024;
const MAX_RUNTIME_DOWNLOAD_BYTES = 512 * 1024 * 1024;

interface PetConfig {
  enabled: boolean;
  slug: string;
  apiKey: string;
  chatBaseUrl: string;
  chatModel: string;
  longPressUrl: string;
  monthlyTokenBudget: number;
  proactiveChatEnabled: boolean;
  proactiveChatMinMinutes: number;
  proactiveChatMaxMinutes: number;
}

interface PetAsset {
  slug: string;
  displayName: string;
  rootDir: string;
  petJsonPath: string;
  spritesheetPath: string;
  spritesheetContentType: string;
  description?: string;
}

interface PetManifestEntry {
  slug: string;
  displayName?: string;
  description?: string;
  spritesheetUrl: string;
  petJsonUrl: string;
}

interface PetManifest {
  pets: PetManifestEntry[];
}

interface PetSessionOpenResponse {
  ok: true;
  reply: string;
}

const EMPTY_BUBBLE: PetBubble = { text: '', tone: 'neutral' };

export class PetController implements vscode.Disposable {
  private readonly _onDidChangeStatus = new vscode.EventEmitter<PetRuntimeStatus>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private child: ChildProcess | null = null;
  private server: http.Server | null = null;
  private port = 0;
  private token = '';
  private sseClients = new Set<http.ServerResponse>();
  private startPromise: Promise<void> | null = null;
  private expectedStop = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private eventTimer: NodeJS.Timeout | null = null;
  private proactiveTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private asset: PetAsset | null = null;
  private lastUsage: ClaudeUsageData | null = null;
  private currentEvent: PetEventState | null = null;
  private ambientState: PetState = 'idle';
  private ambientBubbleState: PetState | null = null;
  private ruleCooldowns = new Map<string, number>();
  private lastInteractionAt = 0;
  private lastDirection: 'left' | 'right' | 'center' = 'center';
  private lastDirectionAt = 0;
  private lastDragAt = 0;
  private chatSession: PetChatSession = {
    active: false,
    openedAt: 0,
    latestReply: '',
  };
  private pendingSeed: { text: string; expiresAt: number } | null = null;
  private status: PetRuntimeStatus = {
    enabled: false,
    status: 'stopped',
    message: 'Pet stopped',
  };
  private currentCommand: PetCommandMessage = {
    type: 'pet-update',
    state: 'idle',
    bubble: EMPTY_BUBBLE,
    metrics: this.emptyMetrics(),
    updatedAt: Date.now(),
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConfig: () => PetConfig
  ) {}

  getStatus(): PetRuntimeStatus {
    return { ...this.status };
  }

  async toggle(): Promise<void> {
    if (this.status.status === 'downloading') {
      vscode.window.showInformationMessage('AI Usage Pet: 正在下载运行环境，请稍候...');
      return;
    }
    await this.setEnabled(!this.getConfig().enabled);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    if (enabled) {
      await this.start();
      if (!cfg.get<boolean>('petEnabled', false)) {
        await cfg.update('petEnabled', true, vscode.ConfigurationTarget.Global);
      }
    } else {
      await this.stop(false);
      if (cfg.get<boolean>('petEnabled', false)) {
        await cfg.update('petEnabled', false, vscode.ConfigurationTarget.Global);
      }
    }
  }

  async selectPet(): Promise<void> {
    const picks = await this.getSelectablePets();
    const selected = await vscode.window.showQuickPick(
      picks.map((entry) => ({
        label: entry.displayName,
        description: entry.slug,
        detail: this.describeCatalogEntry(entry),
        entry,
      })),
      {
        placeHolder: 'Select a desktop pet',
      }
    );
    if (!selected) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('deepseek-balance');
    await cfg.update('petSlug', selected.entry.slug, vscode.ConfigurationTarget.Global);
  }

  async importLocalPet(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Import pet folder',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const sourceDir = picked[0].fsPath;
    const sourceAsset = this.readPetAssetFromDir(path.basename(sourceDir), sourceDir);
    if (!sourceAsset) {
      throw new Error('Selected folder must contain pet.json and spritesheet.webp or spritesheet.png.');
    }

    const petJson = this.readPetJson(sourceAsset.petJsonPath);
    const slug = slugifyPetName(path.basename(sourceDir) || petJson.id || petJson.displayName || 'pet');
    const targetDir = path.join(this.importedPetsRoot(), slug);
    fs.mkdirSync(this.importedPetsRoot(), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(sourceAsset.petJsonPath, path.join(targetDir, 'pet.json'));
    const ext = path.extname(sourceAsset.spritesheetPath) || '.webp';
    fs.copyFileSync(sourceAsset.spritesheetPath, path.join(targetDir, 'spritesheet' + ext));
    vscode.window.showInformationMessage('Imported pet: ' + slug);
  }

  async syncWithConfiguration(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      await this.stop(false);
      return;
    }
    const configuredSlug = cfg.slug || DEFAULT_PET_SLUG;
    if (this.child && this.asset && this.asset.slug !== configuredSlug) {
      await this.stop(true);
    }
    await this.start();
    this.scheduleProactiveTimer(true);
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.setStatus({ enabled: true, status: 'running', message: 'Pet running' });
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(enabled = this.getConfig().enabled): Promise<void> {
    this.expectedStop = true;
    this.restartAttempts = 0;
    this.clearTimer('restartTimer');
    this.clearTimer('eventTimer');
    this.clearTimer('proactiveTimer');
    this.currentEvent = null;
    this.pendingSeed = null;
    this.chatSession = { active: false, openedAt: 0, latestReply: '' };
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    await this.stopServer();
    this.setStatus({
      enabled,
      status: 'stopped',
      message: enabled ? 'Pet stopped' : 'Pet disabled',
    });
  }

  updateFromUsage(data: ClaudeUsageData): void {
    this.lastUsage = data;
    const metrics = this.buildMetrics(data);
    if (this.hasActiveEvent()) {
      return;
    }

    const overLimitBubble = this.overLimitBubble(metrics);
    if (overLimitBubble && !this.isRuleCoolingDown('over-limit')) {
      this.markRuleCooldown('over-limit', EVENT_COOLDOWN_MS);
      this.pushEvent('over-limit', 'failed', overLimitBubble, metrics);
      return;
    }

    this.applyAmbient(metrics, false);
    this.scheduleProactiveTimer(false);
  }

  showDailySummary(data: ClaudeUsageData): void {
    this.lastUsage = data;
    const metrics = this.buildMetrics(data);
    const topProject = metrics.topProject || 'unknown';
    const text = metrics.todayTokens > 0
      ? 'Today tokens: ' + this.formatTokens(metrics.todayTokens) + '. Busiest project: ' + topProject
      : 'Today is quiet so far.';
    this.pushEvent('daily-summary', 'waving', { text, tone: 'ok' }, metrics);
  }

  dispose(): void {
    void this.stop(false);
    this._onDidChangeStatus.dispose();
  }

  private async startInternal(): Promise<void> {
    this.expectedStop = false;
    this.setStatus({ enabled: true, status: 'starting', message: 'Starting pet...' });
    try {
      const cached = this.resolveCachedElectronExecutable();
      let electronPath: string;
      if (cached) {
        electronPath = cached;
      } else {
        this.setStatus({ enabled: true, status: 'downloading', message: '正在下载桌面宠物运行环境（首次使用需下载约 100MB，仅此一次）...' });
        electronPath = await this.downloadElectronRuntime();
      }
      const asset = await this.resolvePetAsset();
      this.asset = asset;
      await this.startServer();

      const windowDir = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pet-window').fsPath;
      const packagePath = path.join(windowDir, 'package.json');
      if (!fs.existsSync(packagePath)) {
        throw new Error('Pet window runtime not found: ' + packagePath);
      }

      const storageDir = this.context.globalStorageUri.fsPath;
      fs.mkdirSync(storageDir, { recursive: true });
      const positionPath = path.join(storageDir, 'pet-window-position.json');
      const args = [
        windowDir,
        '--port=' + this.port,
        '--token=' + this.token,
        '--position=' + positionPath,
        '--enable-logging',
      ];

      LOG('Starting Electron pet window on port ' + this.port);
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
          delete childEnv[key];
        }
      }
      childEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
      const child = spawn(electronPath, args, {
        cwd: windowDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.child = child;
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          LOG('Electron stdout: ' + text);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          LOG('Electron stderr: ' + text);
        }
      });
      child.once('error', (err) => {
        if (this.child !== child) {
          return;
        }
        LOG('Electron spawn error: ' + err.message);
        this.child = null;
        void this.stopServer();
        this.setStatus({ enabled: true, status: 'error', message: err.message });
      });
      child.once('exit', (code) => {
        if (this.child !== child) {
          return;
        }
        LOG('Electron exited with code ' + (code === null ? 'null' : code));
        this.child = null;
        if (this.expectedStop) {
          return;
        }
        void this.stopServer();
        this.setStatus({
          enabled: this.getConfig().enabled,
          status: 'error',
          message: 'Pet window exited',
        });
        this.scheduleRestart();
      });

      this.restartAttempts = 0;
      this.setStatus({ enabled: true, status: 'running', message: 'Pet running' });
      this.applyAmbient(this.currentMetrics(), true);
      this.scheduleProactiveTimer(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      LOG('Start failed: ' + message);
      await this.stopServer();
      this.setStatus({ enabled: true, status: 'error', message });
      throw err;
    }
  }

  private scheduleRestart(): void {
    if (!this.getConfig().enabled || this.restartAttempts >= 2) {
      return;
    }
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((err) => LOG('Restart failed: ' + (err instanceof Error ? err.message : String(err))));
    }, 1500);
  }

  private async resolveElectronExecutable(): Promise<string> {
    const development = this.resolveDevelopmentElectronExecutable();
    if (development) {
      return development;
    }
    const cached = this.resolveCachedElectronExecutable();
    if (cached) {
      return cached;
    }
    return this.downloadElectronRuntime();
  }

  private resolveDevelopmentElectronExecutable(): string | null {
    const overrideDist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
    if (overrideDist) {
      const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
      const candidate = path.join(overrideDist, executable);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const packageRoot = path.join(this.context.extensionUri.fsPath, 'node_modules', 'electron');
    const pathFile = path.join(packageRoot, 'path.txt');
    if (!fs.existsSync(pathFile)) {
      return null;
    }
    const relativeExecutable = fs.readFileSync(pathFile, 'utf8').trim();
    if (!relativeExecutable) {
      return null;
    }
    const executablePath = path.join(packageRoot, 'dist', relativeExecutable);
    return fs.existsSync(executablePath) ? executablePath : null;
  }

  private resolveCachedElectronExecutable(): string | null {
    const version = this.getElectronVersion();
    const runtimeRoot = this.getRuntimeRoot(version);
    const executablePath = this.getRuntimeExecutable(runtimeRoot);
    return fs.existsSync(executablePath) ? executablePath : null;
  }

  private async downloadElectronRuntime(): Promise<string> {
    const version = this.getElectronVersion();
    const runtimeRoot = this.getRuntimeRoot(version);
    const executablePath = this.getRuntimeExecutable(runtimeRoot);
    if (fs.existsSync(executablePath)) {
      return executablePath;
    }

    const archiveName = this.getElectronArchiveName(version);
    const downloadUrl = 'https://github.com/electron/electron/releases/download/v' + version + '/' + archiveName;
    const storageRoot = path.join(this.context.globalStorageUri.fsPath, 'runtime');
    const tempRoot = path.join(storageRoot, 'tmp');
    const archivePath = path.join(tempRoot, archiveName);
    const extractRoot = runtimeRoot + '.partial-' + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(tempRoot, { recursive: true });

    // Clean up any stale partial directories from previous interrupted downloads
    this.cleanupPartialDirs(path.dirname(runtimeRoot));

    fs.mkdirSync(extractRoot, { recursive: true });
    LOG('Downloading Electron runtime: ' + archiveName);
    try {
      await this.downloadToFile(downloadUrl, archivePath, MAX_RUNTIME_DOWNLOAD_BYTES);
      await this.extractArchive(archivePath, extractRoot);
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
      fs.renameSync(extractRoot, runtimeRoot);
      fs.rmSync(archivePath, { force: true });
    } catch (err) {
      try { fs.rmSync(extractRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error('下载运行环境失败：' + message + '。请检查网络连接后重试。');
    }

    if (!fs.existsSync(executablePath)) {
      throw new Error('下载完成但未找到可执行文件，请重试。');
    }
    return executablePath;
  }

  private getElectronVersion(): string {
    const rootPackagePath = path.join(this.context.extensionUri.fsPath, 'package.json');
    if (!fs.existsSync(rootPackagePath)) {
      return '42.0.1';
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const rawVersion = parsed.dependencies?.electron || '42.0.1';
      const match = rawVersion.match(/\d+\.\d+\.\d+/);
      return match ? match[0] : '42.0.1';
    } catch {
      return '42.0.1';
    }
  }

  private getRuntimeRoot(version: string): string {
    const platformArch = process.platform + '-' + process.arch;
    return path.join(this.context.globalStorageUri.fsPath, 'runtime', platformArch, 'electron-v' + version);
  }

  private cleanupPartialDirs(parentDir: string): void {
    if (!fs.existsSync(parentDir)) { return; }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(parentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('electron-v') && entry.name.includes('.partial')) {
        const dirPath = path.join(parentDir, entry.name);
        try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* locked by another process, will try again next time */ }
      }
    }
  }

  private getRuntimeExecutable(runtimeRoot: string): string {
    if (process.platform === 'win32') {
      return path.join(runtimeRoot, 'electron.exe');
    }
    if (process.platform === 'darwin') {
      return path.join(runtimeRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    }
    return path.join(runtimeRoot, 'electron');
  }

  private getElectronArchiveName(version: string): string {
    return 'electron-v' + version + '-' + process.platform + '-' + process.arch + '.zip';
  }

  private async extractArchive(archivePath: string, destination: string): Promise<void> {
    if (process.platform === 'win32') {
      await this.runExternalCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath "' + archivePath + '" -DestinationPath "' + destination + '" -Force',
      ]);
      return;
    }
    if (process.platform === 'darwin') {
      await this.runExternalCommand('ditto', ['-x', '-k', archivePath, destination]);
      return;
    }
    await this.runExternalCommand('unzip', ['-o', archivePath, '-d', destination]);
  }

  private runExternalCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(command + ' exited with code ' + code + (stderr.trim() ? ': ' + stderr.trim() : '')));
      });
    });
  }

  private setStatus(status: PetRuntimeStatus): void {
    this.status = status;
    this._onDidChangeStatus.fire(this.getStatus());
  }

  private async startServer(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        LOG('HTTP error: ' + (err instanceof Error ? err.message : String(err)));
        if (!res.headersSent) {
          this.json(res, 500, { ok: false, error: 'internal_error' });
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
  }

  private async stopServer(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1:' + (this.port || 1));
    if (url.pathname !== '/health' && !this.isAuthorized(req, url)) {
      this.json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      this.json(res, 200, this.currentCommand);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      this.openEventStream(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/asset/spritesheet') {
      this.streamSpritesheet(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interaction') {
      await this.handleInteraction(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/long-press') {
      await this.openLongPressTarget();
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/open') {
      this.json(res, 200, this.openChatSession());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/close') {
      this.closeChatSession();
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      await this.handleChat(req, res);
      return;
    }

    this.json(res, 404, { ok: false, error: 'not_found' });
  }

  private setCors(res: http.ServerResponse): void {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,x-ai-usage-pet-token');
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers['x-ai-usage-pet-token'];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const token = headerToken || url.searchParams.get('token') || '';
    return token === this.token;
  }

  private openEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    this.sseClients.add(res);
    res.write('data: ' + JSON.stringify(this.currentCommand) + '\n\n');
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }

  private streamSpritesheet(res: http.ServerResponse): void {
    if (!this.asset || !fs.existsSync(this.asset.spritesheetPath)) {
      this.json(res, 404, { ok: false, error: 'asset_missing' });
      return;
    }
    res.writeHead(200, {
      'content-type': this.asset.spritesheetContentType,
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(this.asset.spritesheetPath).pipe(res);
  }

  private async handleInteraction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let event: PetInteractionEvent;
    try {
      event = JSON.parse(await this.readBody(req, MAX_HTTP_BODY_BYTES)) as PetInteractionEvent;
    } catch {
      this.json(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    if (!event || typeof event.type !== 'string') {
      this.json(res, 400, { ok: false, error: 'invalid_event' });
      return;
    }

    this.handleInteractionEvent(event);
    this.json(res, 200, { ok: true });
  }

  private handleInteractionEvent(event: PetInteractionEvent): void {
    const now = Date.now();
    this.lastInteractionAt = now;
    if (event.direction && (event.type === 'drag-start' || event.type === 'drag-move' || event.type === 'drag-end')) {
      this.lastDirection = event.direction;
      this.lastDirectionAt = now;
      this.lastDragAt = now;
    }

    if (
      this.currentEvent &&
      this.currentEvent.id === 'hold-start' &&
      (event.type === 'hover' || event.type === 'drag-start' || event.type === 'drag-move' || event.type === 'drag-end')
    ) {
      this.clearTimer('eventTimer');
      this.currentEvent = null;
      this.applyAmbient(this.currentMetrics(), false);
    }

    if (event.type === 'hold-start') {
      this.pushEvent('hold-start', 'waiting', EMPTY_BUBBLE, this.currentMetrics());
      return;
    }

    if (event.type === 'chat-open') {
      this.scheduleProactiveTimer(true);
      return;
    }

    if (event.type === 'chat-close') {
      this.scheduleProactiveTimer(true);
      return;
    }

    if (event.type === 'double-tap') {
      const text = this.buildTodayUsageLine(this.currentMetrics());
      this.pushEvent('double-tap', 'waving', { text, tone: 'ok' }, this.currentMetrics());
      return;
    }

    if (event.type === 'tap') {
      this.pushEvent('tap', 'waving', EMPTY_BUBBLE, this.currentMetrics());
      return;
    }

    if (event.type === 'hold-complete') {
      this.scheduleProactiveTimer(true);
      return;
    }

    if (event.type === 'drag-start' || event.type === 'drag-move') {
      const direction = event.direction || this.lastDirection;
      const state = direction === 'left'
        ? 'running-left'
        : direction === 'right'
          ? 'running-right'
          : 'idle';
      this.clearTimer('eventTimer');
      this.currentEvent = null;
      this.currentCommand = {
        type: 'pet-update',
        state,
        bubble: EMPTY_BUBBLE,
        metrics: this.currentMetrics(),
        updatedAt: Date.now(),
      };
      this.broadcast(this.currentCommand);
      this.scheduleProactiveTimer(false);
      return;
    }

    if (event.type === 'drag-end') {
      this.applyAmbient(this.currentMetrics(), false);
      this.scheduleProactiveTimer(false);
      return;
    }

    if (!this.hasActiveEvent()) {
      this.applyAmbient(this.currentMetrics(), false);
    }
    this.scheduleProactiveTimer(false);
  }

  private async openLongPressTarget(): Promise<void> {
    const target = this.getConfig().longPressUrl || 'https://www.bilibili.com';
    const uri = vscode.Uri.parse(target);
    this.handleInteractionEvent({ type: 'hold-complete', direction: this.lastDirection });
    await vscode.env.openExternal(uri);
    this.pushEvent('hold-complete', 'jumping', { text: 'Opened long-press link.', tone: 'ok' }, this.currentMetrics());
  }

  private openChatSession(): PetSessionOpenResponse {
    this.handleInteractionEvent({ type: 'chat-open', direction: this.lastDirection });
    this.chatSession = {
      active: true,
      openedAt: Date.now(),
      latestReply: '',
    };
    const seed = this.pendingSeed && this.pendingSeed.expiresAt > Date.now() ? this.pendingSeed.text : '';
    this.chatSession.latestReply = seed;
    this.pendingSeed = null;
    return {
      ok: true,
      reply: seed,
    };
  }

  private closeChatSession(): void {
    this.handleInteractionEvent({ type: 'chat-close', direction: this.lastDirection });
    this.chatSession = {
      active: false,
      openedAt: 0,
      latestReply: '',
    };
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let request: PetChatRequest;
    try {
      request = JSON.parse(await this.readBody(req, MAX_HTTP_BODY_BYTES)) as PetChatRequest;
    } catch {
      this.json(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    const message = typeof request.message === 'string' ? request.message.trim() : '';
    if (!message) {
      this.json(res, 400, { ok: false, error: 'empty_message' });
      return;
    }

    if (!this.chatSession.active) {
      this.openChatSession();
    }

    const metrics = this.currentMetrics();
    this.pushEvent('chat-waiting', 'waiting', { text: 'Thinking...', tone: 'neutral' }, metrics);
    try {
      const reply = await this.requestChatCompletion(message);
      this.chatSession.latestReply = reply;
      this.pushEvent('chat-reply', 'idle', { text: this.shortBubble(reply), tone: 'ok' }, this.currentMetrics());
      this.json(res, 200, { ok: true, reply });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const safeMessage = messageText.includes('API key') ? messageText : 'Chat failed: ' + messageText;
      this.pushEvent('chat-error', 'failed', { text: safeMessage.slice(0, 120), tone: 'danger' }, this.currentMetrics(), CHAT_ERROR_TTL_MS);
      this.json(res, 500, { ok: false, error: safeMessage });
    }
  }

  private async requestChatCompletion(userMessage: string): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) {
      throw new Error('Please set your DeepSeek API key first.');
    }
    const endpoint = new URL('chat/completions', cfg.chatBaseUrl.replace(/\/+$/, '') + '/');
    const prompt = this.buildPromptContext();
    const systemPrompt = buildPetChatPrompt({
      displayName: this.asset?.displayName || '桌宠',
      description: this.asset?.description,
      context: prompt,
    });
    const body = JSON.stringify({
      model: cfg.chatModel || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.9,
      max_tokens: 120,
    });
    const response = await this.postJson(endpoint, cfg.apiKey, body);
    const reply = this.normalizeModelReply(response?.choices?.[0]?.message?.content, 'chat');
    this.logModelReply('chat', reply);
    return reply;
  }

  private async requestProactiveLine(): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) {
      throw new Error('Please set your DeepSeek API key first.');
    }
    const endpoint = new URL('chat/completions', cfg.chatBaseUrl.replace(/\/+$/, '') + '/');
    const prompt = this.buildPromptContext();
    const systemPrompt = buildPetProactivePrompt({
      displayName: this.asset?.displayName || '桌宠',
      description: this.asset?.description,
      context: prompt,
    });
    const body = JSON.stringify({
      model: cfg.chatModel || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '现在主动说一句。' },
      ],
      temperature: 1.0,
      max_tokens: 80,
    });
    const response = await this.postJson(endpoint, cfg.apiKey, body);
    const reply = this.normalizeModelReply(response?.choices?.[0]?.message?.content, 'proactive');
    this.logModelReply('proactive', reply);
    return reply;
  }

  private applyAmbient(metrics: PetMetricsSnapshot, allowBubble: boolean): void {
    const nextState = this.computeAmbientState(metrics);
    const stateChanged = nextState !== this.ambientState;
    this.ambientState = nextState;
    const bubble = allowBubble && stateChanged && this.ambientBubbleState !== nextState
      ? this.ambientBubbleForState(nextState)
      : EMPTY_BUBBLE;
    this.ambientBubbleState = nextState;
    this.currentCommand = {
      type: 'pet-update',
      state: nextState,
      bubble,
      metrics,
      updatedAt: Date.now(),
    };
    this.broadcast(this.currentCommand);
  }

  private computeAmbientState(metrics: PetMetricsSnapshot): PetState {
    void metrics;
    return 'idle';
  }

  private ambientBubbleForState(state: PetState): PetBubble {
    void state;
    return EMPTY_BUBBLE;
  }

  private pushEvent(
    id: string,
    state: PetState,
    bubble: PetBubble,
    metrics: PetMetricsSnapshot,
    ttlMs = EVENT_TTL_MS
  ): void {
    this.clearTimer('eventTimer');
    this.currentEvent = {
      id,
      state,
      bubble,
      expiresAt: Date.now() + ttlMs,
    };
    this.currentCommand = {
      type: 'pet-update',
      state,
      bubble,
      metrics,
      updatedAt: Date.now(),
    };
    this.broadcast(this.currentCommand);
    this.eventTimer = setTimeout(() => {
      this.currentEvent = null;
      this.applyAmbient(this.currentMetrics(), true);
      this.scheduleProactiveTimer(true);
    }, ttlMs);
  }

  private hasActiveEvent(): boolean {
    return !!this.currentEvent && this.currentEvent.expiresAt > Date.now();
  }

  private markRuleCooldown(id: string, cooldownMs: number): void {
    this.ruleCooldowns.set(id, Date.now() + cooldownMs);
  }

  private isRuleCoolingDown(id: string): boolean {
    return (this.ruleCooldowns.get(id) || 0) > Date.now();
  }

  private buildMetrics(data: ClaudeUsageData): PetMetricsSnapshot {
    const todayKey = this.formatDate(Date.now());
    const today = data.dailyStats.find((d) => d.date === todayKey) || null;
    const recent7 = data.dailyStats.filter((d) => d.date < todayKey).slice(-7);
    const sevenDayAverageTokens = recent7.length > 0
      ? recent7.reduce((sum, d) => sum + this.tokenTotal(d), 0) / recent7.length
      : 0;
    const topProject = data.topProjects.length > 0
      ? this.decodeProjectName(data.topProjects[0].projectDir)
      : undefined;
    const monthToDateTokens = this.monthToDateTokens(data);
    return {
      todayTokens: today ? this.tokenTotal(today) : 0,
      todayCalls: today ? today.callCount : 0,
      sevenDayAverageTokens,
      topProject,
      monthToDateTokens,
      projectedMonthlyTokens: data.projectedMonthlyTokens || 0,
      monthlyTokenBudget: this.getConfig().monthlyTokenBudget || 0,
      lastInteractionAt: this.lastInteractionAt,
    };
  }

  private currentMetrics(): PetMetricsSnapshot {
    return this.lastUsage ? this.buildMetrics(this.lastUsage) : this.currentCommand.metrics;
  }

  private emptyMetrics(): PetMetricsSnapshot {
    return {
      todayTokens: 0,
      todayCalls: 0,
      sevenDayAverageTokens: 0,
      monthToDateTokens: 0,
      projectedMonthlyTokens: 0,
      monthlyTokenBudget: 0,
      lastInteractionAt: 0,
    };
  }

  private buildPromptContext(): PetPromptContext {
    const metrics = this.currentMetrics();
    return {
      todayTokens: metrics.todayTokens,
      todayCalls: metrics.todayCalls,
      topProject: metrics.topProject,
      budgetStatus: this.describeBudgetStatus(metrics),
    };
  }

  private normalizeModelReply(content: unknown, mode: 'chat' | 'proactive'): string {
    if (typeof content === 'string') {
      const compact = content.replace(/\s+/g, ' ').trim();
      if (compact) {
        return compact.length > 40 ? compact.slice(0, 40) : compact;
      }
    }
    throw new Error('模型返回了空消息，请稍后重试');
  }

  private logModelReply(mode: 'chat' | 'proactive', reply: string): void {
    const compact = reply.replace(/\s+/g, ' ').trim();
    LOG('Model reply [' + mode + ']: ' + (compact || '(empty)'));
  }

  private broadcast(command: PetCommandMessage): void {
    const payload = 'data: ' + JSON.stringify(command) + '\n\n';
    for (const client of Array.from(this.sseClients)) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private tokenTotal(d: DailyStats): number {
    return d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
  }

  private monthToDateTokens(data: ClaudeUsageData): number {
    const monthKey = this.formatDate(Date.now()).slice(0, 7);
    return data.dailyStats
      .filter((d) => d.date.startsWith(monthKey))
      .reduce((sum, d) => sum + this.tokenTotal(d), 0);
  }

  private overLimitBubble(metrics: PetMetricsSnapshot): PetBubble | null {
    if (metrics.monthlyTokenBudget > 0 && metrics.projectedMonthlyTokens > metrics.monthlyTokenBudget) {
      return { text: 'Projected monthly usage may exceed your token budget.', tone: 'danger' };
    }
    const threshold = Math.max(500_000, metrics.sevenDayAverageTokens * 1.8);
    if (metrics.todayTokens > 0 && metrics.todayTokens >= threshold) {
      return {
        text: 'Today is ' + this.safeRatio(metrics.todayTokens, metrics.sevenDayAverageTokens) + 'x the recent average.',
        tone: 'warning',
      };
    }
    return null;
  }

  private describeBudgetStatus(metrics: PetMetricsSnapshot): string {
    if (metrics.monthlyTokenBudget > 0 && metrics.projectedMonthlyTokens > metrics.monthlyTokenBudget) {
      return 'projected-over-budget';
    }
    if (metrics.monthlyTokenBudget > 0 && metrics.monthToDateTokens >= metrics.monthlyTokenBudget * 0.8) {
      return 'budget-80-percent-used';
    }
    if (metrics.todayTokens > 0 && metrics.todayTokens >= Math.max(500_000, metrics.sevenDayAverageTokens * 1.8)) {
      return 'today-usage-high';
    }
    return 'stable';
  }

  private buildTodayUsageLine(metrics: PetMetricsSnapshot): string {
    if (!metrics.todayTokens && !metrics.todayCalls) {
      return 'Today is quiet. I am watching it.';
    }
    const project = metrics.topProject || 'current project';
    return `Today: ${this.formatTokens(metrics.todayTokens)} tokens. Busiest project: ${project}`;
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  private decodeProjectName(dir: string): string {
    const match = dir.match(/^[A-Za-z]-+(.+)$/);
    return match ? match[1] : dir;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) {
      return (n / 1_000_000).toFixed(2) + 'M';
    }
    if (n >= 1_000) {
      return (n / 1_000).toFixed(1) + 'K';
    }
    return Math.round(n).toString();
  }

  private shortBubble(reply: string): string {
    const compact = reply.replace(/\s+/g, ' ').trim();
    return compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
  }

  private safeRatio(todayTokens: number, avgTokens: number): string {
    if (avgTokens <= 0) {
      return '1.0';
    }
    return (todayTokens / avgTokens).toFixed(1);
  }

  private async resolvePetAsset(): Promise<PetAsset> {
    const slug = this.getConfig().slug || DEFAULT_PET_SLUG;
    const directCandidates = [
      path.join(this.localAppPetsRoot(), slug),
      path.join(os.homedir(), '.codex', 'pets', slug),
      path.join(os.homedir(), '.petdex', 'pets', slug),
      path.join(this.importedPetsRoot(), slug),
      path.join(this.builtInPetsRoot(), slug),
      path.join(this.downloadedPetsRoot(), slug),
      path.join(this.legacyDownloadedPetsRoot(), slug),
    ];
    for (const dir of directCandidates) {
      const asset = this.readPetAssetFromDir(slug, dir);
      if (asset) {
        LOG('Using pet asset "' + slug + '" from ' + asset.rootDir);
        return asset;
      }
    }
    return this.downloadPetAsset(slug, path.join(this.downloadedPetsRoot(), slug));
  }

  private builtInPetsRoot(): string {
    return path.join(this.context.extensionUri.fsPath, 'media', 'pets');
  }

  private localAppPetsRoot(): string {
    return path.join(os.homedir(), '.ai-usage-monitor', 'pets');
  }

  private importedPetsRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'pets', 'imported');
  }

  private downloadedPetsRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'pets', 'downloaded');
  }

  private legacyDownloadedPetsRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'pets');
  }

  private async getSelectablePets(): Promise<PetCatalogEntry[]> {
    const bySlug = new Map<string, PetCatalogEntry>();

    const roots: Array<{ root: string; source: PetCatalogEntry['source'] }> = [
      { root: this.localAppPetsRoot(), source: 'local-app' },
      { root: path.join(os.homedir(), '.codex', 'pets'), source: 'local-codex' },
      { root: path.join(os.homedir(), '.petdex', 'pets'), source: 'local-petdex' },
      { root: this.importedPetsRoot(), source: 'imported' },
      { root: this.builtInPetsRoot(), source: 'builtin' },
      { root: this.downloadedPetsRoot(), source: 'downloaded' },
      { root: this.legacyDownloadedPetsRoot(), source: 'downloaded' },
    ];

    for (const { root, source } of roots) {
      for (const entry of this.readCatalogEntries(root, source)) {
        if (!bySlug.has(entry.slug)) {
          bySlug.set(entry.slug, entry);
        }
      }
    }
    for (const entry of BUILTIN_PET_CATALOG) {
      if (!bySlug.has(entry.slug)) {
        bySlug.set(entry.slug, entry);
      }
    }
    return Array.from(bySlug.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private readCatalogEntries(root: string, source: PetCatalogEntry['source']): PetCatalogEntry[] {
    if (!fs.existsSync(root)) {
      return [];
    }
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const slug = entry.name;
        const asset = this.readPetAssetFromDir(slug, path.join(root, slug));
        if (!asset) {
          return null;
        }
        return {
          slug,
          displayName: asset.displayName,
          description: asset.description,
          source,
          bundled: source === 'builtin',
        } as PetCatalogEntry;
      })
      .filter((entry): entry is PetCatalogEntry => !!entry);
  }

  private describeCatalogEntry(entry: PetCatalogEntry): string {
    const labels: Record<PetCatalogEntry['source'], string> = {
      builtin: entry.bundled ? 'Built in' : 'Built in catalog',
      downloaded: 'Downloaded cache',
      imported: 'Imported by you',
      'local-app': 'From ~/.ai-usage-monitor/pets',
      'local-codex': 'From ~/.codex/pets',
      'local-petdex': 'From ~/.petdex/pets',
      remote: 'Remote catalog',
    };
    return labels[entry.source] + (entry.description ? ' - ' + entry.description : '');
  }

  private readPetAssetFromDir(slug: string, dir: string): PetAsset | null {
    const petJsonPath = path.join(dir, 'pet.json');
    const webpPath = path.join(dir, 'spritesheet.webp');
    const pngPath = path.join(dir, 'spritesheet.png');
    const spritesheetPath = fs.existsSync(webpPath) ? webpPath : fs.existsSync(pngPath) ? pngPath : '';
    if (!fs.existsSync(petJsonPath) || !spritesheetPath) {
      return null;
    }
    const petJson = this.readPetJson(petJsonPath);
    return {
      slug,
      displayName: petJson.displayName || slug,
      description: petJson.description,
      rootDir: dir,
      petJsonPath,
      spritesheetPath,
      spritesheetContentType: spritesheetPath.endsWith('.png') ? 'image/png' : 'image/webp',
    };
  }

  private readPetJson(petJsonPath: string): { id?: string; displayName?: string; description?: string } {
    try {
      const parsed = JSON.parse(fs.readFileSync(petJsonPath, 'utf8')) as {
        id?: unknown;
        displayName?: unknown;
        description?: unknown;
      };
      return {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        displayName: typeof parsed.displayName === 'string' ? parsed.displayName.trim() : undefined,
        description: typeof parsed.description === 'string' ? parsed.description.trim() : undefined,
      };
    } catch {
      return {};
    }
  }

  private async downloadPetAsset(slug: string, storageRoot: string): Promise<PetAsset> {
    LOG('Downloading pet asset: ' + slug);
    fs.mkdirSync(storageRoot, { recursive: true });
    const manifest = await this.requestJson<PetManifest>(PET_MANIFEST_URL);
    const pet = manifest.pets.find((p) => p.slug === slug);
    if (!pet) {
      throw new Error('Pet slug not found in Petdex manifest: ' + slug);
    }
    const petJson = await this.requestBuffer(pet.petJsonUrl, MAX_ASSET_BYTES);
    let spriteExt = '.webp';
    if (pet.spritesheetUrl.toLowerCase().includes('.png')) {
      spriteExt = '.png';
    }
    const sprite = await this.requestBuffer(pet.spritesheetUrl, MAX_ASSET_BYTES);
    fs.writeFileSync(path.join(storageRoot, 'pet.json'), petJson);
    fs.writeFileSync(path.join(storageRoot, 'spritesheet' + spriteExt), sprite);
    const asset = this.readPetAssetFromDir(slug, storageRoot);
    if (!asset) {
      throw new Error('Downloaded pet asset was incomplete for ' + slug);
    }
    return asset;
  }

  private scheduleProactiveTimer(forceReset: boolean): void {
    if (forceReset) {
      this.clearTimer('proactiveTimer');
    }
    if (this.proactiveTimer || !this.getConfig().enabled || !this.child) {
      return;
    }
    const cfg = this.getConfig();
    if (!cfg.proactiveChatEnabled || !cfg.apiKey || this.chatSession.active || this.hasActiveEvent() || !this.hasRecentActivity()) {
      return;
    }
    const minMinutes = Math.max(1, cfg.proactiveChatMinMinutes || 8);
    const maxMinutes = Math.max(minMinutes, cfg.proactiveChatMaxMinutes || 18);
    const delayMinutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      void this.emitProactiveLine();
    }, delayMinutes * 60 * 1000);
  }

  private hasRecentActivity(): boolean {
    const recentUsageAt = this.lastUsage
      ? Math.max(0, ...this.lastUsage.topSessions.map((session) => session.lastActiveAt || 0))
      : 0;
    const latest = Math.max(this.lastInteractionAt, recentUsageAt);
    return latest > 0 && Date.now() - latest <= 60 * 60 * 1000;
  }

  private async emitProactiveLine(): Promise<void> {
    if (!this.getConfig().enabled || !this.child || this.chatSession.active || this.hasActiveEvent() || !this.hasRecentActivity()) {
      this.scheduleProactiveTimer(true);
      return;
    }
    try {
      const text = await this.requestProactiveLine();
      const proactiveStates: PetState[] = [
        'jumping',
        Math.random() > 0.5 ? 'running-left' : 'running-right',
        'review',
      ];
      const state = proactiveStates[Math.floor(Math.random() * proactiveStates.length)];
      this.pendingSeed = {
        text,
        expiresAt: Date.now() + EVENT_TTL_MS,
      };
      this.pushEvent('proactive', state, { text, tone: 'neutral' }, this.currentMetrics());
    } catch (err) {
      LOG('Proactive line failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.scheduleProactiveTimer(true);
    }
  }

  private clearTimer(name: 'restartTimer' | 'eventTimer' | 'proactiveTimer'): void {
    const timer = this[name];
    if (timer) {
      clearTimeout(timer);
      this[name] = null;
    }
  }

  private readBody(req: http.IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          reject(new Error('request_body_too_large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private json(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(body));
  }

  private async requestJson<T>(url: string): Promise<T> {
    const buffer = await this.requestBuffer(url, MAX_ASSET_BYTES);
    return JSON.parse(buffer.toString('utf8')) as T;
  }

  private requestBuffer(urlText: string, limit: number, redirects = 0): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlText);
      const transport = url.protocol === 'http:' ? http : https;
      const req = transport.get(url, {
        headers: { 'user-agent': 'AI Usage Monitor VS Code Extension' },
      }, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 4) {
          res.resume();
          const next = new URL(location, url).toString();
          this.requestBuffer(next, limit, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error('HTTP ' + status + ' for ' + url.hostname));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > limit) {
            req.destroy(new Error('response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(20_000, () => req.destroy(new Error('request_timeout')));
      req.on('error', reject);
    });
  }

  private downloadToFile(urlText: string, destination: string, limit: number, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlText);
      const transport = url.protocol === 'http:' ? http : https;
      const request = transport.get(url, {
        headers: { 'user-agent': 'AI Usage Monitor VS Code Extension' },
      }, (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 4) {
          response.resume();
          const next = new URL(location, url).toString();
          this.downloadToFile(next, destination, limit, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error('HTTP ' + status + ' for ' + url.hostname));
          return;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const stream = fs.createWriteStream(destination);
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > limit) {
            request.destroy(new Error('response_too_large'));
            return;
          }
        });
        stream.on('finish', () => resolve());
        stream.on('error', reject);
        response.on('error', reject);
        response.pipe(stream);
      });

      request.setTimeout(60_000, () => request.destroy(new Error('request_timeout')));
      request.on('error', (err) => {
        fs.rmSync(destination, { force: true });
        reject(err);
      });
    });
  }

  private postJson(endpoint: URL, apiKey: string, body: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const transport = endpoint.protocol === 'http:' ? http : https;
      const req = transport.request(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > CHAT_RESPONSE_LIMIT) {
            req.destroy(new Error('chat_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            reject(new Error('model_http_' + (res.statusCode || 0)));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('invalid_model_json'));
          }
        });
      });
      req.setTimeout(30_000, () => req.destroy(new Error('model_timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

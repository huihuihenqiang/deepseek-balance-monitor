const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

function readArg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const port = readArg('port', '');
const token = readArg('token', '');
const positionPath = readArg('position', '');
const windowSize = { width: 360, height: 470 };

let win = null;
let drag = null;

function enforceAlwaysOnTop() {
  if (!win || win.isDestroyed()) {
    return;
  }
  const level = process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu';
  win.setAlwaysOnTop(true, level);
  if (typeof win.moveTop === 'function') {
    win.moveTop();
  }
}

function readSavedBounds() {
  if (!positionPath || !fs.existsSync(positionPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(positionPath, 'utf8'));
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: parsed.x, y: parsed.y, ...windowSize };
    }
  } catch {
    return null;
  }
  return null;
}

function clampBounds(bounds) {
  const point = {
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  };
  const area = screen.getDisplayNearestPoint(point).workArea;
  const minY = area.y - bounds.height + 144;
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x - bounds.width + 48), area.x + area.width - 48),
    y: Math.min(Math.max(bounds.y, minY), area.y + area.height - 48),
  };
}

function saveBounds() {
  if (!win || !positionPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(positionPath), { recursive: true });
    const bounds = win.getBounds();
    fs.writeFileSync(positionPath, JSON.stringify({ x: bounds.x, y: bounds.y }, null, 2));
  } catch {
    // Best effort only.
  }
}

function createWindow() {
  const fallback = screen.getPrimaryDisplay().workArea;
  const saved = readSavedBounds();
  const initialBounds = saved || {
    x: fallback.x + fallback.width - windowSize.width - 40,
    y: fallback.y + fallback.height - windowSize.height - 60,
    ...windowSize,
  };

  win = new BrowserWindow({
    ...clampBounds(initialBounds),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  enforceAlwaysOnTop();
  win.loadFile(path.join(__dirname, 'index.html'), {
    query: { port, token },
  });
  win.once('ready-to-show', () => {
    if (win) {
      win.showInactive();
      enforceAlwaysOnTop();
    }
  });
  win.on('blur', enforceAlwaysOnTop);
  win.on('focus', enforceAlwaysOnTop);
  win.on('show', enforceAlwaysOnTop);
  win.on('move', saveBounds);
  win.on('closed', () => {
    win = null;
  });
}

ipcMain.on('drag-start', (_event, pos) => {
  if (!win) {
    return;
  }
  win.setIgnoreMouseEvents(false);
  enforceAlwaysOnTop();
  drag = {
    startX: pos.screenX,
    startY: pos.screenY,
    bounds: win.getBounds(),
  };
});

ipcMain.on('drag-move', (_event, pos) => {
  if (!win || !drag) {
    return;
  }
  const next = {
    ...drag.bounds,
    x: Math.round(drag.bounds.x + pos.screenX - drag.startX),
    y: Math.round(drag.bounds.y + pos.screenY - drag.startY),
  };
  win.setBounds(clampBounds(next), false);
});

ipcMain.on('drag-end', () => {
  drag = null;
  enforceAlwaysOnTop();
  saveBounds();
});

ipcMain.on('set-click-through', (_event, ignore) => {
  if (!win || drag) {
    return;
  }
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
  if (!ignore) {
    enforceAlwaysOnTop();
  }
});

app.whenReady().then(createWindow);
app.on('before-quit', saveBounds);
app.on('window-all-closed', () => app.quit());

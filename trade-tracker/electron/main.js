// electron/main.js
const { app, BrowserWindow, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
const http   = require('http');

const DEFAULT_PORT    = 3002;
let chosenPort     = DEFAULT_PORT; // updated when backend announces its port
const BACKEND_TIMEOUT = 120000; // 2 minutes — allows for Defender scanning on first launch
const POLL_INTERVAL   = 300;

const IS_PACKAGED = app.isPackaged;
const appDataPath = app.getPath('userData').replace(/[^\\\/]*$/, 'MyOptionDiary');
const logFile     = path.join(appDataPath, 'startup.log');

try { if (!fs.existsSync(appDataPath)) fs.mkdirSync(appDataPath, { recursive: true }); } catch {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

log('Electron main starting. Packaged: ' + IS_PACKAGED);

const BACKEND_SCRIPT = IS_PACKAGED
  ? path.join(process.resourcesPath, 'backend', 'trade-tracker-backend.js')
  : path.join(__dirname, '..', 'trade-tracker-backend.js');

const NODE_BINARY = IS_PACKAGED
  ? path.join(process.resourcesPath, 'node', 'node.exe')
  : 'node';

let backendProcess = null;
let mainWindow     = null;

// ── Spawn backend ──────────────────────────────────────────
function spawnBackend() {
  if (!fs.existsSync(BACKEND_SCRIPT)) {
    log('ERROR: Backend script not found: ' + BACKEND_SCRIPT);
    return;
  }

  log('Spawning backend: ' + BACKEND_SCRIPT);

  const nodeBin = IS_PACKAGED && fs.existsSync(NODE_BINARY) ? NODE_BINARY : 'node';

  backendProcess = spawn(nodeBin, [BACKEND_SCRIPT], {
    env: {
      ...process.env,
      OTT_ELECTRON:  '1',
      OTT_RESOURCES: IS_PACKAGED ? process.resourcesPath : path.join(__dirname, '..'),
      NODE_ENV:      'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Read chosen port from backend stdout
  // Backend writes "BACKEND_PORT=3002\n" (or whichever port it chose)
  backendProcess.stdout?.on('data', d => {
    const text = d.toString();
    const match = text.match(/BACKEND_PORT=(\d+)/);
    if (match) {
      chosenPort = parseInt(match[1], 10);
      log(`Backend announced port: ${chosenPort}`);
    }
    log('[backend] ' + text.trim());
  });
  backendProcess.stderr?.on('data', d => log('[backend ERR] ' + d.toString().trim()));

  backendProcess.on('exit', (code, signal) => {
    log(`Backend exited. Code: ${code}, Signal: ${signal}`);
    if (mainWindow && !app.isQuitting) {
      dialog.showErrorBox(
        'MyOptionDiary — Backend Error',
        `The backend process stopped unexpectedly.\n\nError code: ${code}\n\nCheck the log file at:\n${logFile}`
      );
    }
  });
}

// ── Poll health endpoint ──────────────────────────────────
function pollHealth() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function tryPoll() {
      if (Date.now() - start > BACKEND_TIMEOUT) return reject(new Error('Backend timed out after ' + BACKEND_TIMEOUT + 'ms'));
      const req = http.get(`http://127.0.0.1:${chosenPort}/health`, { timeout: 1000 }, res => {
        if (res.statusCode === 200 || res.statusCode === 402) {
          log('Backend ready (HTTP ' + res.statusCode + ')');
          resolve();
        } else {
          setTimeout(tryPoll, POLL_INTERVAL);
        }
        res.resume();
      });
      req.on('error', () => setTimeout(tryPoll, POLL_INTERVAL));
      req.on('timeout', () => { req.destroy(); setTimeout(tryPoll, POLL_INTERVAL); });
    }
    tryPoll();
  });
}

// ── Create window ─────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1280,
    height:          820,
    minWidth:        900,
    minHeight:       600,
    backgroundColor: '#f5f4f0',
    show:            false,
    webPreferences:  {
      nodeIntegration:     false,
      contextIsolation:    true,
      webSecurity:         true,
      allowRunningInsecureContent: false,
    },
    ...(IS_PACKAGED && fs.existsSync(path.join(__dirname, 'icon.ico'))
      ? { icon: path.join(__dirname, 'icon.ico') }
      : {}),
  });

  // Inject chosen port into window so App.jsx getBase() uses the right port
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`window.__BACKEND_PORT__ = ${chosenPort};`);
  });
  // Show loading screen while backend starts
  mainWindow.loadURL('data:text/html,<html><body style="background:#0e0d0b;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:monospace;color:#c8941f;margin:0"><div style="font-size:32px;margin-bottom:16px">&#x1F4C8;</div><div style="font-size:14px;letter-spacing:.1em">MYOPTIONDIARY</div><div style="font-size:11px;color:#8a8680;margin-top:12px;letter-spacing:.05em">Starting up...</div></body></html>');
  // Then load the real app
  setTimeout(() => mainWindow.loadURL(`http://127.0.0.1:${chosenPort}`), 800);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    log('Window shown');

    // ── Security hardening (production only) ────────────
    if (IS_PACKAGED) {
      // Block keyboard shortcuts that open DevTools or reload
      mainWindow.webContents.on('before-input-event', (event, input) => {
        const blocked = (
          (input.key === 'F12') ||
          (input.control && input.shift && input.key === 'I') ||
          (input.control && input.shift && input.key === 'J') ||
          (input.control && input.shift && input.key === 'C') ||
          (input.control && input.key === 'u') ||   // View source
          (input.control && input.key === 'r') ||   // Hard reload
          (input.key === 'F5')
        );
        if (blocked) event.preventDefault();
      });

      // Prevent right-click context menu (exposes "Inspect Element")
      mainWindow.webContents.on('context-menu', (event) => {
        event.preventDefault();
      });
    }
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://') && !url.includes('127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.includes('127.0.0.1') && !url.startsWith('app://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────

// Single instance lock — prevents running two copies simultaneously
// (a technique sometimes used to try to bypass license checks)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('Another instance is already running — quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  log('App ready. Starting backend...');
  log('resourcesPath: ' + (IS_PACKAGED ? process.resourcesPath : 'dev mode'));
  log('Node binary: ' + (fs.existsSync(NODE_BINARY) ? NODE_BINARY + ' (found)' : 'using system node'));
  log('Backend script: ' + BACKEND_SCRIPT + (fs.existsSync(BACKEND_SCRIPT) ? ' (found)' : ' (NOT FOUND)'));

  // Log all key resource paths to help diagnose blank page issues
  if (IS_PACKAGED) {
    const rp = process.resourcesPath;
    const paths = [
      path.join(rp, 'app', 'index.html'),
      path.join(rp, 'backend', 'trade-tracker-backend.js'),
      path.join(rp, 'backend', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(rp, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];
    paths.forEach(p => log('  ' + (fs.existsSync(p) ? '✓' : '✗') + ' ' + p));
  }
  spawnBackend();

  try {
    await pollHealth();
    createWindow();
  } catch (e) {
    log('FATAL: ' + e.message);
    const nodeStatus   = fs.existsSync(NODE_BINARY)     ? 'Bundled node.exe found' : 'Using system Node.js';
    const scriptStatus = fs.existsSync(BACKEND_SCRIPT)  ? 'Backend script found'   : 'Backend script MISSING';
    dialog.showErrorBox(
      'MyOptionDiary — Startup Failed',
      `Could not start the backend server.\n\n${e.message}\n\n${nodeStatus}\n${scriptStatus}\n\nCheck the log file for details:\n${logFile}`
    );
    app.quit();
  }
});

app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
    log('Backend killed');
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

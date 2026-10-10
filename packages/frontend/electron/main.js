const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  safeStorage,
  protocol,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const net = require('net');
const dns = require('dns');
const fs = require('fs');

const APP_NAME = 'FAIRWallet';
const APP_ID = 'in.fairco.wallet';
const APP_URL = 'https://fairco.in';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const BRAND_BACKGROUND = '#1b1e09';
const DEEP_LINK_SCHEME = 'faircoin';

// Identify the app to the OS (Windows taskbar grouping, GNOME "recent apps",
// macOS dock) as FAIRWallet instead of the generic "Electron" default.
app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: 'Lightweight SPV wallet for FairCoin',
  website: APP_URL,
  iconPath: ICON_PATH,
});

// Register the `fairwallet://` scheme as a standard, secure origin BEFORE
// the app is ready. Without this, Chromium treats it as opaque (like data:
// or javascript:) and `new URL(relative, 'fairwallet://local/index.html')`
// throws "Invalid base URL" — breaking expo-router and RN-for-Web asset
// resolution.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fairwallet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Register the app as the default handler for `faircoin://` URIs so the OS
// routes BIP21-style deep links back to the wallet.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// Single-instance lock: if the user launches FAIRWallet twice (e.g. by
// double-clicking a `faircoin:` link while the app is already running),
// bring the existing window to the foreground and forward the new link
// instead of spawning a second process.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
}

let mainWindow = null;
const peerConnections = new Map();

/**
 * Resolve the dist directory path.
 * In production (electron-builder), files are in extraResources/dist.
 * In development, they are in the project root dist/.
 */
function getDistPath() {
  if (process.resourcesPath) {
    const resourceDist = path.join(process.resourcesPath, 'dist');
    if (fs.existsSync(resourceDist)) {
      return resourceDist;
    }
  }
  return path.join(__dirname, '..', 'dist');
}

/**
 * Register a custom app:// protocol to serve the Expo web export.
 *
 * Expo Router expects to be served from a root URL (e.g. http://host/).
 * Loading via file:// gives a path like file:///C:/Users/.../dist/index.html
 * which breaks route matching. A custom protocol maps app://. to the dist
 * directory so the router sees clean paths starting from /.
 */
function registerAppProtocol() {
  const distPath = getDistPath();

  protocol.registerFileProtocol('fairwallet', (request, callback) => {
    // The page is loaded via app://local/index.html so relative asset
    // requests from the HTML (e.g. /_expo/static/js/entry.js) resolve to
    // app://local/_expo/static/... — a valid URL we can parse.
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      pathname = '/index.html';
    }

    // Strip leading slash so path.join doesn't interpret as absolute
    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }

    if (!pathname) {
      pathname = 'index.html';
    }

    const filePath = path.join(distPath, pathname);

    // Only serve the file if it exists AND is a real file. Fall back to
    // index.html for SPA routing (expo-router) so unknown routes still load.
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      callback({ path: filePath });
    } else {
      callback({ path: path.join(distPath, 'index.html') });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    icon: ICON_PATH,
    width: 440,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: BRAND_BACKGROUND,
    // macOS: traffic lights inset into the title bar area, leaving the
    // content full-bleed underneath.
    // Windows/Linux: overlay the window controls on a themed bar so the
    // frame matches FAIRWallet's dark background instead of the OS chrome.
    titleBarStyle: 'hiddenInset',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : {
            color: BRAND_BACKGROUND,
            symbolColor: '#f3f4f6',
            height: 36,
          },
    // Defer first paint until React has rendered a frame so users don't
    // see a white flash when the window opens.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Block navigating the main window away from the app shell; open every
  // external URL in the user's default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('fairwallet://') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('fairwallet://') && !url.startsWith('http://localhost')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  const isDev = process.argv.includes('--dev');
  if (isDev) {
    mainWindow.loadURL('http://localhost:8081');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('fairwallet://local/');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [, socket] of peerConnections) {
      socket.destroy();
    }
    peerConnections.clear();
  });
}

/**
 * Scan a set of arguments (startup argv or second-instance argv) for a
 * `faircoin://` URI and forward it to the renderer so the app can open
 * the Send screen pre-filled (BIP21-style).
 */
function extractDeepLink(argv) {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}:`));
}

function forwardDeepLink(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('deep-link', url);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
    ],
  });

  template.push({
    role: 'help',
    submenu: [
      {
        label: `Learn More about ${APP_NAME}`,
        click: () => shell.openExternal(APP_URL),
      },
      {
        label: 'Explorer',
        click: () => shell.openExternal('https://explorer.fairco.in'),
      },
      {
        label: 'Report Issue',
        click: () => shell.openExternal('https://github.com/FairCoinOfficial/FAIRWallet/issues'),
      },
      ...(isMac
        ? []
        : [
            { type: 'separator' },
            {
              label: `About ${APP_NAME}`,
              click: () => app.showAboutPanel(),
            },
          ]),
    ],
  });

  return template;
}

app.on('second-instance', (_event, argv) => {
  const link = extractDeepLink(argv);
  if (link) {
    forwardDeepLink(link);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS delivers deep links via `open-url`, not argv.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    forwardDeepLink(url);
  } else {
    app.whenReady().then(() => forwardDeepLink(url));
  }
});

app.whenReady().then(() => {
  registerAppProtocol();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu()));
  nativeTheme.themeSource = 'dark';
  createWindow();

  const initialLink = extractDeepLink(process.argv);
  if (initialLink && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      forwardDeepLink(initialLink);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ---- IPC Handlers: TCP P2P Networking ----

let connectionIdCounter = 0;

ipcMain.handle('p2p:connect', (_event, host, port) => {
  return new Promise((resolve, reject) => {
    const id = String(++connectionIdCounter);
    const socket = new net.Socket();

    socket.connect(port, host, () => {
      peerConnections.set(id, socket);
      resolve(id);
    });

    socket.on('data', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:data', id, new Uint8Array(data));
      }
    });

    socket.on('close', () => {
      peerConnections.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:close', id);
      }
    });

    socket.on('error', (err) => {
      peerConnections.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:error', id, err.message);
      }
      reject(err);
    });

    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
});

ipcMain.handle('p2p:send', (_event, connectionId, data) => {
  const socket = peerConnections.get(connectionId);
  if (!socket) {
    throw new Error(`No connection with id ${connectionId}`);
  }
  socket.write(Buffer.from(data));
});

ipcMain.handle('p2p:disconnect', (_event, connectionId) => {
  const socket = peerConnections.get(connectionId);
  if (socket) {
    socket.destroy();
    peerConnections.delete(connectionId);
  }
});

// ---- IPC Handlers: DNS Resolution ----

ipcMain.handle('dns:resolve', (_event, hostname) => {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        reject(err);
      } else {
        resolve(addresses);
      }
    });
  });
});

// ---- IPC Handlers: Secure Storage ----

ipcMain.handle('secure:encrypt', (_event, plaintext) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this system');
  }
  const encrypted = safeStorage.encryptString(plaintext);
  return new Uint8Array(encrypted);
});

ipcMain.handle('secure:decrypt', (_event, encrypted) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this system');
  }
  return safeStorage.decryptString(Buffer.from(encrypted));
});

ipcMain.handle('secure:isAvailable', () => {
  return safeStorage.isEncryptionAvailable();
});

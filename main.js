'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  shell
} = require('electron');
const fs = require('fs');
const path = require('path');

const association = require('./main/association');
const { validatePath, fileArgFrom } = require('./main/paths');
const { buildMenu } = require('./main/menu');
const { addRecent, pruneRecent, samePath } = require('./main/recent');
const { createStore, THEMES } = require('./main/settings');
const { restoreBounds, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT } = require('./main/window-state');
const { clampZoomLevel, nextZoomLevel, zoomPercent } = require('./main/zoom');

const APP_NAME = 'Light MD Viewer';
const WATCH_DEBOUNCE_MS = 150;
const BOUNDS_DEBOUNCE_MS = 400;
const MAX_CLIPBOARD_CHARS = 1024 * 1024;
const SMOKE = process.argv.includes('--smoke');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {fs.FSWatcher|null} */
let watcher = null;
let watchTimer = null;
let boundsTimer = null;
let currentFile = null;
let rendererReady = false;
/** Payload produced before the renderer finished loading (launch via file association). */
let pendingPayload = null;
/** @type {ReturnType<typeof createStore>|null} Created once the app is ready. */
let settings = null;

// ---------------------------------------------------------------- title / send

function setTitle(suffix) {
  if (!win || win.isDestroyed()) return;
  win.setTitle(suffix ? `${suffix} — ${APP_NAME}` : APP_NAME);
}

function sendFileLoaded(payload) {
  pendingPayload = payload;
  if (!win || win.isDestroyed() || !rendererReady) return;
  win.webContents.send('file:loaded', payload);
}

function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function messageBox(options) {
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options);
}

function showError(title, detail) {
  return messageBox({ type: 'error', title, message: title, detail, buttons: ['OK'] });
}

// ---------------------------------------------------------------- watching

function stopWatching() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* already gone */
    }
    watcher = null;
  }
}

function watchCurrentFile() {
  stopWatching();
  const target = currentFile;
  if (!target) return;
  try {
    watcher = fs.watch(target, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (currentFile !== target) return;
        if (!validatePath(target)) {
          // Deleted or renamed: keep the last rendered content, just flag it in the title.
          stopWatching();
          setTitle(`${path.basename(target)} (missing)`);
          return;
        }
        // Re-watch as well: atomic saves (write-temp + rename) invalidate the old handle.
        loadFile(target);
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => stopWatching());
  } catch {
    watcher = null; // Watching is best effort; never fatal.
  }
}

// ---------------------------------------------------------------- loading

function loadFile(candidate) {
  const file = validatePath(candidate);
  if (!file) return false;
  let content;
  try {
    // Windows editors still write "UTF-8 with BOM". The mark is not content: left in place it
    // renders as literal text ahead of the first heading and hides a front matter block, because
    // neither marked nor splitFrontmatter can see a '---' fence that does not start the line.
    content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return false;
  }
  const hadFile = currentFile !== null;
  currentFile = file;
  setTitle(path.basename(file));
  sendFileLoaded({ path: file, content, baseDir: path.dirname(file) });
  watchCurrentFile();

  app.addRecentDocument(file); // Windows jump list.
  const listChanged = settings
    ? settings.set('recentFiles', addRecent(settings.get('recentFiles', []), file))
    : false;
  // Reloading the same file changes neither the list nor Print's enabled state: leave the menu be.
  if (listChanged || !hadFile) refreshMenu();
  return true;
}

async function openViaDialog() {
  if (!win || win.isDestroyed()) return false;
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return false;
  return loadFile(result.filePaths[0]);
}

function openRecent(filePath) {
  if (loadFile(filePath)) return;
  // The file has been deleted, renamed or moved since it was added. This is the only place the
  // list is checked, because checking it anywhere else means a blocking stat per entry — see
  // refreshMenu — so the dead entry drops out here, the moment someone actually asks for it.
  if (settings) {
    const stored = settings.get('recentFiles', []);
    settings.set(
      'recentFiles',
      pruneRecent(stored, (entry) => !samePath(entry, filePath))
    );
  }
  refreshMenu();
}

function clearRecent() {
  settings.set('recentFiles', []);
  app.clearRecentDocuments();
  refreshMenu();
}

// ---------------------------------------------------------------- theme

function applyTheme(value) {
  const theme = THEMES.includes(value) ? value : 'system';
  nativeTheme.themeSource = theme;
  return theme;
}

function setTheme(value) {
  // The renderer needs no message: its CSS follows prefers-color-scheme, which themeSource drives.
  settings.set('theme', applyTheme(value));
}

// ---------------------------------------------------------------- zoom

/** The single place a zoom level is decided, for both the View menu and the 'view:zoom' channel. */
function applyZoom(request) {
  if (!win || win.isDestroyed()) return 0;
  const current = clampZoomLevel(win.webContents.zoomLevel);
  const level = nextZoomLevel(current, request);
  if (level === null) return current; // Unusable request: report the level, change nothing.
  win.webContents.zoomLevel = level;
  sendToRenderer('zoom:changed', { level, percent: zoomPercent(level) });
  return level;
}

// ---------------------------------------------------------------- print / export

function printCurrent() {
  if (!win || win.isDestroyed() || !currentFile) return;
  win.webContents.print({}, (success, reason) => {
    if (success || !reason || /cancel/i.test(reason)) return;
    showError('Printing failed', reason);
  });
}

async function exportPdf() {
  if (!win || win.isDestroyed() || !currentFile) return;
  const base = path.basename(currentFile, path.extname(currentFile));
  const result = await dialog.showSaveDialog(win, {
    title: 'Export as PDF',
    defaultPath: path.join(path.dirname(currentFile), `${base}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return;
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    await fs.promises.writeFile(result.filePath, pdf);
  } catch (error) {
    showError('Export failed', `Could not write the PDF.\n\n${error.message}`);
  }
}

// ---------------------------------------------------------------- Windows integration

async function registerFileType() {
  const exePath = process.execPath;
  try {
    await association.register(exePath);
  } catch (error) {
    showError(
      'Registration failed',
      `${error.message}\n\nNothing outside HKEY_CURRENT_USER was touched.`
    );
    return;
  }
  const devNote = app.isPackaged
    ? ''
    : '\n\nThis is a development run, so the program registered above is Electron itself. That is ' +
      'genuinely what would open the file; register again from the installed app for a lasting ' +
      'association.';
  const { response } = await messageBox({
    type: 'info',
    title: 'Registered',
    message: `${APP_NAME} now appears in the Windows "Open with" list for .md and .markdown files.`,
    detail:
      `Registered program:\n${exePath}\n\n` +
      'To make it the default: right-click a .md file → Open with → Choose another app → ' +
      `${APP_NAME} → Always.\n\n` +
      'Moving or renaming this program breaks the registration; run this menu item again ' +
      `afterwards.${devNote}`,
    buttons: ['OK', 'Open Default Apps settings'],
    defaultId: 0,
    cancelId: 0
  });
  if (response === 1) shell.openExternal('ms-settings:defaultapps');
}

async function unregisterFileType() {
  try {
    await association.unregister();
  } catch (error) {
    showError('Unregistration failed', error.message);
    return;
  }
  await messageBox({
    type: 'info',
    title: 'Unregistered',
    message: `${APP_NAME} has been removed from the Windows "Open with" list.`,
    detail:
      'Windows may keep showing it until Explorer is restarted. If it was set as the default ' +
      'app for .md files, pick a new default in Settings → Apps → Default apps.',
    buttons: ['OK']
  });
}

// ---------------------------------------------------------------- menu

function refreshMenu() {
  // The stored list is used as it stands. Validating it here would mean a blocking stat per entry
  // on the main thread, and one entry on a network share is enough to make that a real problem:
  // a disconnected share stalls the menu (and, from createWindow, the whole startup) for the SMB
  // timeout, and a share that answers is handed an authentication attempt nobody asked for. A
  // path that no longer opens is dropped by openRecent instead.
  const recentFiles = settings ? settings.get('recentFiles', []) : [];

  Menu.setApplicationMenu(
    buildMenu({
      appName: APP_NAME,
      version: app.getVersion(),
      hasFile: currentFile !== null,
      theme: settings ? settings.get('theme', 'system') : 'system',
      recentFiles,
      getWindow: () => win,
      onOpen: () => openViaDialog(),
      onOpenRecent: (filePath) => openRecent(filePath),
      onClearRecent: () => clearRecent(),
      onReload: () => currentFile && loadFile(currentFile),
      onPrint: () => printCurrent(),
      onExportPdf: () => exportPdf(),
      onRegisterFileType: () => registerFileType(),
      onUnregisterFileType: () => unregisterFileType(),
      onZoom: (request) => applyZoom(request),
      onTheme: (value) => setTheme(value),
      onFind: () => sendToRenderer('ui:open-find'),
      onToggleOutline: () => sendToRenderer('ui:toggle-outline')
    })
  );
}

// ---------------------------------------------------------------- window

function saveBounds() {
  // The smoke run opens and closes a window in a second; it must not overwrite real settings.
  if (SMOKE || !settings || !win || win.isDestroyed() || win.isMinimized()) return;
  // getNormalBounds() is the un-maximised rectangle, which is the one worth restoring.
  const { x, y, width, height } = win.getNormalBounds();
  settings.set('windowBounds', { x, y, width, height, maximized: win.isMaximized() });
}

function scheduleSaveBounds() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    saveBounds();
  }, BOUNDS_DEBOUNCE_MS);
}

function createWindow() {
  // `frame` carries x/y only when the saved position is still on a screen; without them Electron
  // centres the window, which is exactly the wanted fallback.
  const { maximized, ...frame } = restoreBounds(
    settings.get('windowBounds'),
    screen.getAllDisplays(),
    DEFAULT_BOUNDS
  );

  win = new BrowserWindow({
    ...frame,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#ffffff',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (pendingPayload) win.webContents.send('file:loaded', pendingPayload);
  });

  // The page's <title> must not clobber a file name set before the page finished loading.
  win.on('page-title-updated', (event) => event.preventDefault());

  // The app never loads remote content and never opens child windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
    win.on(event, scheduleSaveBounds);
  }

  win.once('ready-to-show', () => {
    if (SMOKE) {
      process.stdout.write('SMOKE_OK\n');
      app.quit();
      return;
    }
    // Maximising a window that has never been shown leaves the page unpainted on Windows,
    // so the restore has to wait until there is a frame to show.
    if (maximized) win.maximize();
    win.show();
  });

  win.on('close', () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    saveBounds();
    if (settings && !SMOKE) settings.flush();
  });

  win.on('closed', () => {
    stopWatching();
    win = null;
  });

  refreshMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------- IPC (entire surface)

ipcMain.handle('file:open-dialog', () => openViaDialog());

ipcMain.handle('file:open-path', (_event, filePath) => loadFile(filePath));

ipcMain.handle('link:open-external', (_event, url) => {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  shell.openExternal(parsed.href);
  return true;
});

ipcMain.handle('view:zoom', (_event, request) => applyZoom(request));

ipcMain.handle('clipboard:write-text', (_event, text) => {
  if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) return false;
  clipboard.writeText(text);
  return true;
});

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const file = fileArgFrom(argv);
    if (!file) return;
    // A relative argument is relative to the SECOND instance's directory, not this one's.
    const base =
      typeof workingDirectory === 'string' && workingDirectory ? workingDirectory : process.cwd();
    loadFile(path.resolve(base, file));
  });

  app.whenReady().then(() => {
    settings = createStore(path.join(app.getPath('userData'), 'settings.json'));
    applyTheme(settings.get('theme', 'system'));
    createWindow();
    const file = fileArgFrom(process.argv);
    if (file) loadFile(file);
  });

  app.on('before-quit', () => {
    if (settings && !SMOKE) settings.flush();
  });

  app.on('window-all-closed', () => app.quit());
}

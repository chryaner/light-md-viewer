'use strict';

// The application menu. Every action is supplied by the caller, so this module owns no state
// and never reaches for the current window or the current file by itself. It is rebuilt (not
// mutated) whenever something it displays changes: the recent list, the theme, whether a file
// is open.

const { Menu, dialog } = require('electron');

const { menuLabel } = require('./recent');
const { THEMES } = require('./settings');
const { ZOOM_STEP } = require('./zoom');

const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

function recentSubmenu(recentFiles, onOpenRecent, onClearRecent) {
  const files = Array.isArray(recentFiles) ? recentFiles : [];
  if (files.length === 0) return [{ label: 'No recent files', enabled: false }];
  return [
    ...files.map((filePath, index) => ({
      // Alt+1..9 then Alt+0 for the tenth, the way Windows apps have always numbered this list.
      label: `&${index < 9 ? index + 1 : 0}  ${menuLabel(filePath)}`,
      click: () => onOpenRecent(filePath)
    })),
    { type: 'separator' },
    { label: 'Clear Recent', click: () => onClearRecent() }
  ];
}

function themeSubmenu(theme, onTheme) {
  return THEMES.map((value) => ({
    label: THEME_LABELS[value],
    type: 'radio',
    checked: theme === value,
    click: () => onTheme(value)
  }));
}

/**
 * @param {object} deps
 * @param {string} deps.appName        Product name, used in the About box.
 * @param {string} deps.version        Version string, used in the About box.
 * @param {boolean} deps.hasFile       Whether a file is open (enables Print / Export as PDF).
 * @param {string} deps.theme          'system' | 'light' | 'dark', for the radio state.
 * @param {string[]} deps.recentFiles  Most recent first; already pruned by the caller.
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow Parent for the About box.
 * @param {() => void} deps.onOpen                  File > Open…
 * @param {(filePath: string) => void} deps.onOpenRecent  File > Open Recent > <path>
 * @param {() => void} deps.onClearRecent           File > Open Recent > Clear Recent
 * @param {() => void} deps.onReload                File > Reload
 * @param {() => void} deps.onPrint                 File > Print…
 * @param {() => void} deps.onExportPdf             File > Export as PDF…
 * @param {() => void} deps.onRegisterFileType      File > Windows Integration > Register…
 * @param {() => void} deps.onUnregisterFileType    File > Windows Integration > Unregister
 * @param {(request: number|'reset') => void} deps.onZoom  View > Zoom In / Out / Reset
 * @param {(theme: string) => void} deps.onTheme    View > Theme > …
 * @param {() => void} deps.onFind                  View > Find…
 * @param {() => void} deps.onToggleOutline         View > Toggle Outline
 * @returns {import('electron').Menu}
 */
function buildMenu(deps) {
  const {
    appName,
    version,
    hasFile,
    theme,
    recentFiles,
    getWindow,
    onOpen,
    onOpenRecent,
    onClearRecent,
    onReload,
    onPrint,
    onExportPdf,
    onRegisterFileType,
    onUnregisterFileType,
    onZoom,
    onTheme,
    onFind,
    onToggleOutline
  } = deps;

  const fileSubmenu = [
    { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => onOpen() },
    { label: 'Open Recent', submenu: recentSubmenu(recentFiles, onOpenRecent, onClearRecent) },
    { label: 'Reload', accelerator: 'F5', click: () => onReload() },
    { type: 'separator' },
    { label: 'Print…', accelerator: 'CmdOrCtrl+P', enabled: hasFile, click: () => onPrint() },
    { label: 'Export as PDF…', enabled: hasFile, click: () => onExportPdf() }
  ];

  if (process.platform === 'win32') {
    fileSubmenu.push(
      { type: 'separator' },
      {
        label: 'Windows Integration',
        submenu: [
          {
            label: 'Register as an Open-with app for Markdown',
            click: () => onRegisterFileType()
          },
          { label: 'Unregister', click: () => onUnregisterFileType() }
        ]
      }
    );
  }

  fileSubmenu.push({ type: 'separator' }, { label: 'Exit', role: 'quit' });

  return Menu.buildFromTemplate([
    { label: '&File', submenu: fileSubmenu },
    {
      label: '&View',
      submenu: [
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => onFind() },
        {
          label: 'Toggle Outline',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => onToggleOutline()
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => onZoom(ZOOM_STEP) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => onZoom(-ZOOM_STEP) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => onZoom('reset') },
        { type: 'separator' },
        { label: 'Theme', submenu: themeSubmenu(theme, onTheme) }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(getWindow(), {
              type: 'info',
              title: `About ${appName}`,
              message: appName,
              detail: `Version ${version}`,
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ]);
}

module.exports = { buildMenu };

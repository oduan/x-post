'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_PORT } = require('./lib/config');
const { createTweetStore } = require('./lib/store');
const { startServer } = require('./lib/server');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let config = null;
let store = null;
let tray = null;
let isQuitting = false;
let closeTipShown = false;

// ---------- 应用内更新 ----------
// Windows：electron-updater + NSIS（GitHub Releases 提供更新元数据），点击按钮下载、完成后自动安装
// macOS：未签名构建无法自动更新，检测到新版本后按钮跳转 Releases 页手动下载
const GITHUB_OWNER = 'oduan';
const GITHUB_REPO = 'x-post';
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 每 4 小时定时检查

let updateStatus = 'idle'; // idle | available | downloading | downloaded
let updateVersion = null;
let updateProgress = 0;

function newerThan(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function pushUpdateStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', {
      status: updateStatus,
      version: updateVersion,
      progress: updateProgress,
      platform: process.platform,
    });
  }
}

async function checkForUpdate() {
  if (!app.isPackaged) return; // 开发模式不检查
  try {
    if (process.platform === 'win32') {
      await autoUpdater.checkForUpdates(); // 结果由事件回调推送
    } else {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
      if (!res.ok) return;
      const j = await res.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      if (latest && newerThan(latest, app.getVersion())) {
        updateStatus = 'available';
        updateVersion = latest;
        pushUpdateStatus();
      }
    }
  } catch (e) {
    console.error('[x-post] 检查更新失败:', e && e.message);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    autoUpdater.autoDownload = false; // 用户点击「发现新版本」按钮后再开始下载
    autoUpdater.on('update-available', (info) => {
      updateStatus = 'available';
      updateVersion = info.version;
      pushUpdateStatus();
    });
    autoUpdater.on('update-not-available', () => {
      updateStatus = 'idle';
      updateVersion = null;
      pushUpdateStatus();
    });
    autoUpdater.on('download-progress', (p) => {
      updateStatus = 'downloading';
      updateProgress = Math.round(p.percent);
      pushUpdateStatus();
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateStatus = 'downloaded';
      updateVersion = info.version;
      pushUpdateStatus();
    });
    autoUpdater.on('error', (e) => {
      console.error('[x-post] 自动更新出错:', e && e.message);
    });
  }
  setTimeout(checkForUpdate, 5000); // 启动时检查一次
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL);
}

// 数据变化通知渲染端：携带变更本身（新增/更新的完整记录、删除的 id），
// 渲染端做增量插卡/更新，不再整表重拉
function notifyChanged(event, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let payload;
  if (event === 'upsert' && data && data.id) {
    payload = { event, tweet: resolveTweetForRenderer(data) };
  } else if (event === 'delete') {
    payload = { event, id: String(data) };
  } else {
    payload = { event: 'reload' };
  }
  mainWindow.webContents.send('tweets:changed', payload);
}

function resolveTweetForRenderer(t) {
  const root = config.dataDir;
  return {
    ...t,
    avatarUrl: t.avatar ? pathToFileURL(path.join(root, t.avatar)).href : null,
    media: (t.media || []).map((m) => ({
      ...m,
      localUrl: m.path ? pathToFileURL(path.join(root, m.path)).href : null,
      posterLocalUrl: m.posterPath ? pathToFileURL(path.join(root, m.posterPath)).href : null,
    })),
  };
}

function registerIpc() {
  ipcMain.handle('tweets:page', (e, q) => {
    const r = store.page(q || {});
    return { ...r, items: r.items.map(resolveTweetForRenderer) };
  });

  ipcMain.handle('tweets:count', (e, q) => store.count(q || {}));

  ipcMain.handle('tweets:delete', (e, id) => store.deleteTweet(String(id)));

  ipcMain.handle('config:get', () => ({
    ...config,
    configPath: CONFIG_PATH,
    defaultPort: DEFAULT_PORT,
    dbFile: store ? store.dbPath : path.join(config.dataDir, 'xpost.db'),
  }));

  ipcMain.handle('config:chooseDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择推文数据保存目录',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    config.dataDir = r.filePaths[0];
    saveConfig(config);
    if (store) store.close();
    store = await createTweetStore(config.dataDir, notifyChanged).catch((e) => {
      console.error('[x-post] 创建数据目录失败:', e);
      return null;
    });
    notifyChanged('reload');
    return { ...config, configPath: CONFIG_PATH };
  });

  ipcMain.handle('data:openDir', () => shell.openPath(config.dataDir));

  ipcMain.handle('sys:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return null;
  });

  // 更新按钮：下载新版本（win）/ 跳转下载页（mac）/ 重启安装
  ipcMain.handle('updater:action', () => {
    if (!app.isPackaged) return null;
    if (process.platform !== 'win32') {
      shell.openExternal(RELEASES_URL);
      return null;
    }
    if (updateStatus === 'downloaded') {
      autoUpdater.quitAndInstall(false, true);
    } else if (updateStatus === 'available') {
      updateStatus = 'downloading';
      updateProgress = 0;
      pushUpdateStatus();
      autoUpdater.downloadUpdate().catch((e) => {
        console.error('[x-post] 下载更新失败:', e && e.message);
        updateStatus = 'available'; // 失败回到可重试状态
        pushUpdateStatus();
      });
    }
    return null;
  });

  ipcMain.handle('updater:check', () => checkForUpdate());
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 应用内图标（icons/ 随 asar 打包，__dirname 在开发/打包两种模式下都指向应用根目录）
function appIconPath(name) {
  return path.join(__dirname, 'icons', name);
}

// 任务栏托盘：右键菜单提供显示/退出，左键点击切换窗口
function createTray() {
  const icon = nativeImage.createFromPath(appIconPath('icon32.png'));
  if (icon.isEmpty()) console.error('[x-post] 托盘图标加载失败:', appIconPath('icon32.png'));
  tray = new Tray(icon);
  tray.setToolTip('X-Post · 推文收藏（本地接口运行中）');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          tray.destroy();
          tray = null;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
    else showMainWindow();
  });
}

// 把当前窗口大小/位置写入配置文件，重启后恢复
let saveWinTimer = null;
function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getNormalBounds();
    config.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() };
    saveConfig(config);
  } catch (e) {
    /* ignore */
  }
}
function schedulePersistWindowState() {
  clearTimeout(saveWinTimer);
  saveWinTimer = setTimeout(persistWindowState, 600);
}

function createWindow() {
  // 恢复上次窗口大小；位置需落在某个可见屏幕内，否则交给系统摆放
  const saved = config.window;
  let x = saved && Number.isFinite(saved.x) ? saved.x : null;
  let y = saved && Number.isFinite(saved.y) ? saved.y : null;
  if (x != null && y != null) {
    const visible = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return x >= wa.x - 200 && x <= wa.x + wa.width - 100 && y >= wa.y - 50 && y <= wa.y + wa.height - 100;
    });
    if (!visible) {
      x = null;
      y = null;
    }
  }

  mainWindow = new BrowserWindow({
    width: (saved && saved.width) || 1280,
    height: (saved && saved.height) || 720, // 首次默认 16:9 横向
    ...(x != null && y != null ? { x, y } : {}),
    minWidth: 720,
    minHeight: 480,
    fullscreenable: false, // 禁止系统级全屏：视频全屏请求会失败并触发 fullscreenerror，由界面转为窗口内全屏（避免窗口反复切换闪烁）
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: appIconPath('icon128.png'),
  });
  if (saved && saved.maximized) mainWindow.maximize();

  mainWindow.on('resize', schedulePersistWindowState);
  mainWindow.on('move', schedulePersistWindowState);
  mainWindow.on('close', () => {
    clearTimeout(saveWinTimer);
    persistWindowState();
  });

  // 禁止在窗口内直接打开外部网页
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 点关闭按钮：不退出，隐藏到任务栏托盘（托盘右键可退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (!closeTipShown && tray) {
        closeTipShown = true;
        tray.displayBalloon({
          iconType: 'info',
          title: 'X-Post 仍在运行',
          content: '窗口已最小化到任务栏。点击托盘图标可恢复窗口，右键托盘图标可选择退出。',
        });
      }
    }
  });

  // 开发自检模式：XPOST_SMOKE=1 electron . 启动后 6 秒自动退出并输出 SMOKE_OK
  // （部分环境下 GUI 进程的 stdout 捕获不到，结果同时写入 electron-app/xpost-smoke-ok.txt）
  mainWindow.webContents.once('did-finish-load', () => {
    pushUpdateStatus(); // 窗口（重）加载后同步当前更新状态，恢复顶栏更新按钮
    if (process.env.XPOST_SMOKE) {
      setTimeout(() => {
        let line = 'SMOKE_OK';
        try {
          const p = store.page({ view: 'timeline', limit: 1 });
          line += ` total=${p.total} firstPage=${p.items.length}`;
        } catch (e) {
          line += ` STORE_FAIL ${e && e.message}`;
        }
        try {
          fs.writeFileSync(path.join(__dirname, 'xpost-smoke-ok.txt'), line + '\n', 'utf8');
        } catch (e) {
          /* ignore */
        }
        console.log(line);
        app.quit();
      }, 6000);
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.on('before-quit', () => {
    isQuitting = true;
    if (store) store.close(); // 关闭数据库，checkpoint WAL
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    config = loadConfig();
    store = await createTweetStore(config.dataDir, notifyChanged).catch(async (e) => {
      console.error('[x-post] 初始化推文数据库失败:', e);
      await dialog.showErrorBox('X-Post 启动错误', '推文数据库初始化失败：\n' + ((e && e.message) || e));
      app.quit();
      return null;
    });
    if (!store) return;

    const server = startServer(
      config.port,
      (payload) => store.saveTweet(payload),
      (info) => store.uploadMedia(info),
      (id) => store.existsTweet(id)
    );
    server.on('listening', () => {
      console.log(`[x-post] 本地接口已监听: http://127.0.0.1:${config.port}`);
    });
    server.on('error', (err) => {
      const msg =
        `本地接收服务监听 127.0.0.1:${config.port} 失败：\n${err.message}\n\n` +
        `请确认该端口没有被其他程序占用；如需修改端口，请编辑\n${CONFIG_PATH}\n中的 port 字段后重启（浏览器扩展默认使用端口 ${DEFAULT_PORT}）。`;
      if (process.env.XPOST_SMOKE) {
        console.error('[SMOKE] server error:', err.message);
      } else {
        dialog.showErrorBox('X-Post 启动错误', msg);
      }
    });

    registerIpc();
    createWindow();
    createTray();
    setupAutoUpdater();
  });
}

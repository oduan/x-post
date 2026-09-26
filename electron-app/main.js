'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_PORT } = require('./lib/config');
const { createTweetStore } = require('./lib/store');
const { startServer } = require('./lib/server');

let mainWindow = null;
let config = null;
let store = null;
let tray = null;
let isQuitting = false;
let closeTipShown = false;

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
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 任务栏托盘：右键菜单提供显示/退出，左键点击切换窗口
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'extension', 'icons', 'icon32.png'));
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
    icon: path.join(__dirname, '..', 'extension', 'icons', 'icon128.png'),
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
  });
}

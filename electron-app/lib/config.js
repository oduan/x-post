'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 软件配置文件：用户目录下的点开头 JSON 文件
const CONFIG_PATH = path.join(os.homedir(), '.x-post.json');
const DEFAULT_PORT = 24680; // 与浏览器扩展约定好的固定高位端口（避开 Windows Hyper-V 端口保留区）
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'x-post-data'); // 默认数据目录：用户目录下

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    /* 首次运行时文件不存在，使用默认值 */
  }

  // 上次退出时的窗口状态（记住窗口大小/位置）
  let win = null;
  if (raw.window && typeof raw.window === 'object') {
    win = {
      x: Number.isFinite(raw.window.x) ? Math.floor(raw.window.x) : null,
      y: Number.isFinite(raw.window.y) ? Math.floor(raw.window.y) : null,
      width: Number.isFinite(raw.window.width) && raw.window.width >= 300 ? Math.floor(raw.window.width) : null,
      height: Number.isFinite(raw.window.height) && raw.window.height >= 240 ? Math.floor(raw.window.height) : null,
      maximized: !!raw.window.maximized,
    };
  }

  return {
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir : DEFAULT_DATA_DIR,
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT,
    window: win,
  };
}

function saveConfig(cfg) {
  const out = { dataDir: cfg.dataDir, port: cfg.port };
  if (cfg.window) out.window = cfg.window; // 未记录过窗口状态时省略该字段
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf8');
}

module.exports = { CONFIG_PATH, DEFAULT_PORT, DEFAULT_DATA_DIR, loadConfig, saveConfig };

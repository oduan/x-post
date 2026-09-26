'use strict';

// 最小 Electron 应用入口：仅为 tools/test-store.js 提供 Electron 运行时
// （better-sqlite3 按 Electron ABI 编译，无法在纯 Node 下加载）
require('../test-store.js');

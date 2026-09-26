'use strict';

/**
 * CI 发布用：把版本号写入 electron-app/package.json 与 extension/manifest.json。
 * 用法：node tools/set-version.js <version>   （如 1.2.3，不带 v 前缀）
 * 可选 --extension-only / --app-only 只改其中一边。
 */

const fs = require('fs');
const path = require('path');

const raw = String(process.argv[2] || '').replace(/^v/, '');
// 规范化为 MAJOR.MINOR.PATCH（electron-builder 要求完整三段；v0.1 → 0.1.0）
const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\w.-]+))?$/.exec(raw);
if (!m) {
  console.error('无效版本号: ' + raw);
  process.exit(1);
}
const version = `${m[1]}.${m[2] || 0}.${m[3] || 0}${m[4] ? '-' + m[4] : ''}`;
const only = process.argv[3] || '';

if (only !== '--extension-only') {
  const pkgPath = path.join(__dirname, '..', 'electron-app', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`electron-app/package.json → ${version}`);
}

if (only !== '--app-only') {
  const mfPath = path.join(__dirname, '..', 'extension', 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.version = version;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n', 'utf8');
  console.log(`extension/manifest.json → ${version}`);
}

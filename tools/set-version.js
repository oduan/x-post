'use strict';

/**
 * CI 发布用：把版本号写入 electron-app/package.json 与 extension/manifest.json。
 * 用法：node tools/set-version.js <version>   （如 1.2.3，不带 v 前缀）
 * 可选 --extension-only / --app-only 只改其中一边。
 */

const fs = require('fs');
const path = require('path');

const raw = String(process.argv[2] || '').replace(/^v/, '');
// 必须是完整三段 semver（如 1.2.3）：electron-builder 按「v + package.json 版本号」创建 Release，
// tag 与版本号不一致时产物会发到错误的 Release 里，因此这里不做补段，直接拒绝（快速失败）
if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(raw)) {
  console.error(`无效版本号: ${raw}（tag 必须是三段版本，如 v0.1.0 而不是 v0.1）`);
  process.exit(1);
}
const version = raw;
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

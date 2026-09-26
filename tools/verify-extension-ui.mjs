// 验证设置面板的「浏览器扩展」区块：node tools/verify-extension-ui.mjs [--shot-only]
// 前提：应用已以 --remote-debugging-port=9222 启动（开发模式）。
// 默认全流程：打开设置 → 断言「未连接」+ 引导可见 → 模拟扩展心跳（v0.1.2）→ 断言「已连接」
// → 模拟旧版本心跳（v9.9.9）→ 断言版本不一致提示；截取设置面板到临时目录。
// --shot-only：只截取「未连接」状态（应用刚启动、无心跳时）。
import fs from 'fs';
import os from 'os';
import path from 'path';

const SHOT_ONLY = process.argv.includes('--shot-only');
// 调试端口：--port=9223（打包版验证用不同端口），默认 9222
const CDP_PORT = (process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').split('=')[1];

const BASE = 'http://127.0.0.1:24680';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) throw new Error('未找到 X-Post 页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
function call(method, params) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJson(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EVAL_ERROR: ' + JSON.stringify(r.exceptionDetails));
  return JSON.parse(r.result.value);
}

const readPanel = () => evalJson(`JSON.stringify({
  text: document.getElementById('ext-status-text').textContent,
  dot: document.getElementById('ext-dot').className,
  guideHidden: document.getElementById('ext-guide').hidden,
  hasDirBtn: !!document.getElementById('btn-ext-dir'),
  hasCopyBtn: !!document.getElementById('btn-ext-copy'),
})`);
async function ping(version) {
  const res = await fetch(`${BASE}/api/ping`, { headers: { 'X-Extension-Version': version } });
  if (!res.ok) throw new Error('ping 失败 HTTP ' + res.status);
  return res.json();
}

// 打开设置面板（若已打开先关再开，保证走 renderSettings 流程）
await call('Runtime.evaluate', {
  expression: `(async () => {
    document.getElementById('settings').hidden = true;
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 400));
  })()`,
  awaitPromise: true,
});

const results = {};
results.initial = await readPanel(); // 应用刚启动、无心跳：应为未连接 + 引导展开

// 截图（全窗口，设置面板居中覆盖）
const takeShot = async (name) => {
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(os.tmpdir(), name);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  results.screenshot = shotPath;
};
await takeShot('xpost-ext-disconnected.png');
if (SHOT_ONLY) {
  console.log(JSON.stringify(results, null, 2));
  ws.close();
  process.exit(0);
}

const pong = await ping('0.1.2'); // 模拟扩展心跳，响应应带应用版本
results.pong = pong;
await sleep(5500); // 等渲染端 5 秒轮询刷新
results.connected = await readPanel();

await ping('9.9.9'); // 模拟版本不一致的扩展
await sleep(5500);
results.mismatch = await readPanel();
await takeShot('xpost-ext-settings.png');

console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(0);

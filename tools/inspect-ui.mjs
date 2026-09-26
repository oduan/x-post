// 通过 CDP 读取 X-Post 页面里媒体条带的实际渲染尺寸：node tools/inspect-ui.mjs
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
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

const expr = `(() => {
  const out = [];
  for (const box of document.querySelectorAll('.media.strip')) {
    const track = box.querySelector('.strip-track');
    const items = [...box.querySelectorAll('.strip-item')].map((it) => ({
      rectW: Math.round(it.getBoundingClientRect().width),
      styleAttr: it.getAttribute('style'),
      needAspect: !!it.dataset.needAspect,
      inner: (it.querySelector('img,video') || {}).tagName || null,
      innerW: Math.round((it.querySelector('img,video') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    }));
    out.push({
      tweet: box.dataset.id,
      trackClientW: track.clientWidth,
      trackScrollW: track.scrollWidth,
      single: box.classList.contains('single'),
      items,
    });
  }
  return JSON.stringify(out, null, 1);
})()`;

const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result.value);
ws.close();

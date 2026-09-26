'use strict';

// X-Post 桌面应用的本地接口（固定高位端口，需与 electron-app/lib/config.js 保持一致）
const PORT = 24680;
const BASE = `http://127.0.0.1:${PORT}`;

// 点击工具栏图标：向当前页面注入内容脚本（幂等）并通知其抓取当前推文
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    /* 无法注入的页面（如浏览器内部页）直接忽略 */
  }
  chrome.tabs.sendMessage(tab.id, { type: 'XPOST_CAPTURE' }, () => void chrome.runtime.lastError);
});

// 内容脚本抓取完元信息后：由扩展逐个下载媒体二进制（带进度）上传给本地应用，
// 全部完成后再提交元信息。进度与结果通过 tabs 消息推给页面上的提示条。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'XPOST_SAVE') return undefined;
  const tabId = sender && sender.tab && sender.tab.id;
  saveFlow(msg.payload, tabId);
  return false;
});

function report(tabId, message) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } catch (e) {
    /* 页面已跳转等，忽略 */
  }
}

// 流式下载，按 Content-Length 汇报进度；大小未知时 pct 为 null（不定进度）
async function downloadBlob(url, onPct) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
  const contentType = resp.headers.get('content-type') || '';
  const total = Number(resp.headers.get('content-length') || 0);
  if (!resp.body || !total) {
    onPct(null);
    return { blob: await resp.blob(), contentType };
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  let last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const pct = got / total;
    if (pct - last > 0.02 || pct >= 1) {
      last = pct;
      onPct(Math.min(pct, 1));
    }
  }
  onPct(1);
  return { blob: new Blob(chunks), contentType };
}

async function uploadMedia(tweetId, index, role, url, kind, blob, contentType) {
  let ext = '';
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  if (m) ext = '.' + m[1].toLowerCase();
  const resp = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
      'X-Tweet-Id': String(tweetId),
      'X-Media-Index': String(index),
      'X-Media-Role': role,
      'X-Media-Ext': ext,
    },
    body: blob,
  });
  if (!resp.ok) throw new Error('上传失败 HTTP ' + resp.status);
}

async function saveFlow(payload, tabId) {
  const total = (payload.media || []).length;
  try {
    // 先查重，避免重复下载大文件
    try {
      const q = await fetch(`${BASE}/api/tweets/exists?id=${encodeURIComponent(payload.id)}`);
      const j = await q.json();
      if (j && j.exists) {
        report(tabId, { type: 'XPOST_DONE', ok: true, duplicate: true });
        return;
      }
    } catch (e) {
      /* 查重失败不阻断流程 */
    }

    let i = 0;
    for (const m of payload.media || []) {
      i++;
      const what = m.kind === 'video' ? '视频' : '图片';
      if (m.url) {
        try {
          const { blob, contentType } = await downloadBlob(m.url, (p) =>
            report(tabId, { type: 'XPOST_PROGRESS', label: `正在下载${what} ${i}/${total}`, pct: p })
          );
          report(tabId, { type: 'XPOST_PROGRESS', label: `正在上传${what} ${i}/${total}`, pct: null });
          await uploadMedia(payload.id, i, 'main', m.url, m.kind, blob, contentType);
        } catch (e) {
          /* 下载/上传失败：保留 url，由应用端兜底下载 */
        }
      }
      if (m.poster) {
        try {
          const { blob, contentType } = await downloadBlob(m.poster, (p) =>
            report(tabId, { type: 'XPOST_PROGRESS', label: `正在下载视频封面 ${i}/${total}`, pct: p })
          );
          report(tabId, { type: 'XPOST_PROGRESS', label: `正在上传视频封面 ${i}/${total}`, pct: null });
          await uploadMedia(payload.id, i, 'poster', m.poster, 'image', blob, contentType);
        } catch (e) {
          /* 封面失败可由应用端兜底 */
        }
      }
    }

    report(tabId, { type: 'XPOST_PROGRESS', label: '正在保存…', pct: null });
    const res = await fetch(`${BASE}/api/tweets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    report(tabId, {
      type: 'XPOST_DONE',
      ok: res.ok && data.ok !== false,
      duplicate: !!data.duplicate,
      error: data.error || null,
    });
  } catch (e) {
    report(tabId, { type: 'XPOST_DONE', ok: false, error: (e && e.message) || String(e) });
  }
}

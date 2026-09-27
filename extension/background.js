'use strict';

// X-Post 桌面应用的本地接口（固定高位端口，需与 electron-app/lib/config.js 保持一致）
const PORT = 24680;
const BASE = `http://127.0.0.1:${PORT}`;

// 点击工具栏图标：向当前页面注入内容脚本（幂等）并通知其抓取当前推文/作品
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js', 'x.js', 'douyin.js'],
    });
  } catch (e) {
    /* 无法注入的页面（如浏览器内部页）直接忽略 */
  }
  chrome.tabs.sendMessage(tab.id, { type: 'XPOST_CAPTURE' }, () => void chrome.runtime.lastError);
});

// ---------- 心跳 ----------
// 定期 ping 本地应用，桌面端据此在设置面板显示「扩展已连接」；版本号用于两端不一致提示
const EXT_VERSION = chrome.runtime.getManifest().version;

async function pingServer() {
  try {
    await fetch(`${BASE}/api/ping`, { headers: { 'X-Extension-Version': EXT_VERSION } });
  } catch (e) {
    /* 桌面端未运行：心跳失败无影响 */
  }
}

// Service Worker 每次被唤醒都在顶层重建闹钟（同名校验，存在则重置周期）；
// worker 被回收后，闹钟到期会重新唤醒它，保证浏览器运行期间持续心跳
chrome.alarms.create('xpost-ping', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xpost-ping') pingServer();
});
pingServer();

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

// 流式下载，按 Content-Length 汇报进度；大小未知时 pct 为 null（不定进度）。
// 抖音的媒体直链（含 302 到 CDN）可能需要登录 Cookie，因此对 douyin 域名带上凭据
async function downloadBlob(url, onPct) {
  let credentials = 'omit';
  try {
    // douyin.com / douyinvod.com / douyinpic.com 及其子域
    if (/douyin(vod|pic)?\.com$/.test(new URL(url).hostname)) credentials = 'include';
  } catch (e) {
    /* ignore */
  }
  const resp = await fetch(url, { credentials });
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

// 下载 HLS（m3u8）并拼成单个 mp4：X 的部分视频（尤其受限推文）只有 HLS 流没有 mp4 直链。
// fMP4/CMAF 分段（#EXT-X-MAP 初始化段 + .m4s/.mp4）按顺序拼接即为可播放的 mp4，无需转封装；
// 老的 MPEG-TS 分段 Chromium 无法播放（需要 ffmpeg），直接放弃保留封面。
async function downloadHls(plUrl, onPct) {
  const fetchText = async (u) => {
    const r = await fetch(u, { credentials: 'omit' });
    if (!r.ok) throw new Error('播放列表下载失败 HTTP ' + r.status);
    return r.text();
  };

  let text = await fetchText(plUrl);
  // master 播放列表：取带宽最高的流
  if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
    const lines = text.split('\n');
    let best = null;
    let bestBr = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const br = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#') && br > bestBr) {
        bestBr = br;
        best = uri;
      }
    }
    if (!best) throw new Error('master 播放列表无可用流');
    text = await fetchText(new URL(best, plUrl).toString());
  }
  if (/METHOD=(?!NONE)/.test(text)) throw new Error('加密 HLS 不支持');

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('播放列表为空');
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text);
  if (!map && !/\.(m4s|mp4)(\?|$)/.test(segs[0])) throw new Error('TS 分段不支持');

  const fetchSeg = async (u) => {
    for (let t = 0; ; t++) {
      try {
        const r = await fetch(u, { credentials: 'omit' });
        if (!r.ok) throw new Error('分段下载失败 HTTP ' + r.status);
        return await r.arrayBuffer();
      } catch (e) {
        if (t >= 1) throw e;
        await new Promise((r2) => setTimeout(r2, 500)); // 失败重试一次
      }
    }
  };

  const parts = [];
  let done = 0;
  const totalSegs = segs.length + (map ? 1 : 0);
  const push = (buf) => {
    parts.push(buf);
    done++;
    onPct(done / totalSegs);
  };
  if (map) push(await fetchSeg(new URL(map[1], plUrl).toString()));
  for (const s of segs) push(await fetchSeg(new URL(s, plUrl).toString()));
  return { blob: new Blob(parts), contentType: 'video/mp4' };
}

async function uploadMedia(platform, rawId, index, role, url, kind, blob, contentType) {
  let ext = '';
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  if (m) ext = '.' + m[1].toLowerCase();
  const resp = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
      'X-Platform': platform,
      'X-Tweet-Id': String(rawId),
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
  const platform = payload.platform || 'x';
  try {
    // 先查重，避免重复下载大文件
    try {
      const q = await fetch(
        `${BASE}/api/tweets/exists?id=${encodeURIComponent(payload.id)}&platform=${encodeURIComponent(platform)}`
      );
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
          await uploadMedia(platform, payload.id, i, 'main', m.url, m.kind, blob, contentType);
        } catch (e) {
          /* 下载/上传失败：保留 url，由应用端兜底下载 */
        }
      } else if (m.kind === 'video' && m.hlsUrl) {
        // 只有 HLS 流：按播放列表拼成 mp4 再上传；失败保留封面（卡片标注原因）
        try {
          const { blob } = await downloadHls(m.hlsUrl, (p) =>
            report(tabId, { type: 'XPOST_PROGRESS', label: `正在下载视频(HLS) ${i}/${total}`, pct: p })
          );
          report(tabId, { type: 'XPOST_PROGRESS', label: `正在上传视频 ${i}/${total}`, pct: null });
          await uploadMedia(platform, payload.id, i, 'main', m.hlsUrl, 'video', blob, 'video/mp4');
        } catch (e) {
          /* HLS 拼接失败 */
        }
      }
      if (m.poster) {
        try {
          const { blob, contentType } = await downloadBlob(m.poster, (p) =>
            report(tabId, { type: 'XPOST_PROGRESS', label: `正在下载视频封面 ${i}/${total}`, pct: p })
          );
          report(tabId, { type: 'XPOST_PROGRESS', label: `正在上传视频封面 ${i}/${total}`, pct: null });
          await uploadMedia(platform, payload.id, i, 'poster', m.poster, 'image', blob, contentType);
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

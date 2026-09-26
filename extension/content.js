'use strict';

/**
 * 内容脚本：点击扩展图标后抓取当前推文详情页的
 * 用户名 / 用户 ID / 标题 / 正文 / 图片 / 视频信息，
 * 通过后台脚本发送给本地 X-Post 应用，并根据结果显示临时提示。
 */
(() => {
  if (window.__xpostContentLoaded) return;
  window.__xpostContentLoaded = true;

  const RECENT_KEY = '__recent__';

  // ---------- 页面内临时提示（toast） ----------

  const TOAST_CSS = [
    '.xpost-toast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%) translateY(10px);z-index:2147483647;',
    'padding:10px 18px;border-radius:9999px;color:#fff;font-size:14px;font-family:system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .25s ease,transform .25s ease;pointer-events:none;max-width:80vw;}',
    '.xpost-toast-show{opacity:1;transform:translateX(-50%) translateY(0);}',
    '.xpost-toast-info{background:#536471;}',
    '.xpost-toast-ok{background:#00ba7c;}',
    '.xpost-toast-error{background:#f4212e;}',
    '.xpost-toast-progress{border-radius:16px;background:#1e2732;padding:12px 18px;min-width:260px;}',
    '.xpost-toast-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.xpost-toast-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.25);margin-top:8px;overflow:hidden;}',
    '.xpost-toast-fill{height:100%;width:0;background:#1d9bf0;border-radius:2px;transition:width .2s ease;}',
    '.xpost-toast-bar.indeterminate .xpost-toast-fill{width:35%;animation:xpost-slide 1.1s infinite linear;}',
    '@keyframes xpost-slide{0%{margin-left:-35%}100%{margin-left:100%}}',
  ].join('');

  let toastEl = null;
  let toastTimer = null;

  function ensureToastStyle() {
    if (document.getElementById('xpost-toast-style')) return;
    const s = document.createElement('style');
    s.id = 'xpost-toast-style';
    s.textContent = TOAST_CSS;
    document.documentElement.appendChild(s);
  }

  function showToast(text, kind) {
    if (!document.body) return;
    hideToast();
    ensureToastStyle();
    toastEl = document.createElement('div');
    toastEl.className = 'xpost-toast xpost-toast-' + (kind || 'info');
    toastEl.textContent = text;
    document.body.appendChild(toastEl);
    requestAnimationFrame(() => {
      if (toastEl) toastEl.classList.add('xpost-toast-show');
    });
    if (kind !== 'info') {
      toastTimer = setTimeout(hideToast, 3500); // 几秒后自动消失
    }
  }

  // 带进度条的保存中提示（pct 为 null 时显示不定进度动画）
  function showSaving(label, pct) {
    if (!document.body) return;
    hideToast();
    ensureToastStyle();
    toastEl = document.createElement('div');
    toastEl.className = 'xpost-toast xpost-toast-progress';
    const lab = document.createElement('div');
    lab.className = 'xpost-toast-label';
    lab.textContent = label;
    const bar = document.createElement('div');
    bar.className = 'xpost-toast-bar' + (pct == null ? ' indeterminate' : '');
    const fill = document.createElement('div');
    fill.className = 'xpost-toast-fill';
    if (pct != null) fill.style.width = Math.round(pct * 100) + '%';
    bar.appendChild(fill);
    toastEl.appendChild(lab);
    toastEl.appendChild(bar);
    document.body.appendChild(toastEl);
    requestAnimationFrame(() => {
      if (toastEl) toastEl.classList.add('xpost-toast-show');
    });
  }

  function updateSaving(label, pct) {
    if (!toastEl || !toastEl.classList.contains('xpost-toast-progress')) {
      showSaving(label, pct);
      return;
    }
    toastEl.querySelector('.xpost-toast-label').textContent = label;
    const bar = toastEl.querySelector('.xpost-toast-bar');
    const fill = bar.firstChild;
    if (pct == null) {
      bar.classList.add('indeterminate');
      fill.style.width = '';
    } else {
      bar.classList.remove('indeterminate');
      fill.style.width = Math.round(pct * 100) + '%';
    }
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  // ---------- 页面 / 推文定位 ----------

  function isXSite() {
    const h = location.hostname;
    return h === 'x.com' || h === 'twitter.com' || h === 'www.x.com' || h === 'www.twitter.com';
  }

  function tweetIdFromUrl() {
    const m = /\/status(?:es)?\/(\d{5,25})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // 推文详情页的正文推文可能是 div[data-testid="tweet"]，时间线里是 article[data-testid="tweet"]
  function findTweetElement(id) {
    const candidates = Array.from(document.querySelectorAll('[data-testid="tweet"]')).filter(
      (el) => !el.closest('[data-testid="quoteTweet"]')
    );
    if (!candidates.length) return null;
    if (id) {
      const match = candidates.find((el) => el.querySelector(`a[href*="/status/${id}"] time`));
      if (match) return match;
    }
    return candidates[0];
  }

  // ---------- 元素解析 ----------

  function parseNameBlock(root) {
    const out = { userName: '', userId: '' };
    if (!root) return out;
    const spans = Array.from(root.querySelectorAll('span'));
    for (const s of spans) {
      const t = (s.textContent || '').trim();
      if (!out.userId && /^@[A-Za-z0-9_]{1,20}$/.test(t)) out.userId = t.slice(1);
    }
    for (const s of spans) {
      const a = s.closest('a');
      if (a && a.querySelector('time')) continue; // 时间链接里的文字（如 "2小时"）不是昵称
      const t = (s.textContent || '').trim();
      if (!t || t === '·' || t.startsWith('@')) continue;
      out.userName = t;
      break;
    }
    return out;
  }

  // 取媒体宽高：优先原始尺寸（naturalWidth/videoWidth），
  // 懒加载未完成的图拿不到时退回渲染尺寸（等比缩放过，宽高比仍正确）
  function elSize(el) {
    if (el.naturalWidth || el.naturalHeight) return { width: el.naturalWidth, height: el.naturalHeight };
    if (el.videoWidth || el.videoHeight) return { width: el.videoWidth, height: el.videoHeight };
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) return { width: Math.round(r.width), height: Math.round(r.height) };
    } catch (e) {
      /* ignore */
    }
    return { width: 0, height: 0 };
  }

  function normalizePbs(u) {
    try {
      const url = new URL(u);
      if (url.hostname === 'pbs.twimg.com') url.searchParams.set('name', 'orig'); // 取原图
      return url.toString();
    } catch (e) {
      return u;
    }
  }

  function pickAvatarUrl(el) {
    const img = el.querySelector('img[src*="profile_images"]');
    if (!img) return null;
    let best = img.currentSrc || img.src;
    let bestW = 0;
    for (const part of (img.srcset || '').split(',')) {
      const seg = part.trim().split(/\s+/);
      const u = seg[0];
      const w = parseInt(seg[1], 10) || 0;
      if (u && w >= bestW) {
        bestW = w;
        best = u;
      }
    }
    return best.replace(/_normal\./, '_400x400.');
  }

  // 长文/文章类推文才有标题，普通推文返回空字符串
  function extractTitle(el) {
    const nodes = el.querySelectorAll('[data-testid="articleTitle"], a[href*="/article/"] h2, a[href*="/article/"]');
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (t && t.length > 3) return t;
    }
    return '';
  }

  // 视频直链 URL 里的 ID 可能是推文 ID（ext_tw_video），也可能是媒体 ID（amplify_video）。
  // amplify 的媒体 ID 与推文 ID 不同，但与封面 URL (amplify_video_thumb/<id>/) 一致，可据此关联。
  function mediaIdsFor(tweetId, posters) {
    const ids = [];
    if (tweetId) ids.push(tweetId);
    for (const p of posters || []) {
      const m = /(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d{5,25})\//.exec(String(p || ''));
      if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
    }
    return ids;
  }

  function buildMediaIdMatcher(ids) {
    const parts = ids.map((id) => '(?:ext_tw_video|amplify_video)\\/' + id + '\\/');
    return new RegExp('(?:' + parts.join('|') + ')');
  }

  function performanceVideoUrls(matcher) {
    try {
      return performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((u) => /video\.twimg\.com\/.*\.mp4/.test(u))
        .filter((u) => !matcher || matcher.test(u));
    } catch (e) {
      return [];
    }
  }

  // 直接打开推文详情页时，主推文数据（含视频直链）内嵌在页面 HTML/内联脚本里，
  // 不经过 GraphQL 接口，需要直接扫描 DOM 里的内联脚本
  function videoUrlsFromDom(matcher) {
    const matched = [];
    const groups = new Map(); // 视频ID -> 该视频的 mp4 列表，用于唯一性兜底
    try {
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        if (t.indexOf('video.twimg.com') === -1) continue;
        // 还原 JSON 转义：\/ 、\u002F 、\u0026 、&amp;
        const raw = t
          .replace(/\\\//g, '/')
          .replace(/\\u002[fF]/g, '/')
          .replace(/\\u0026/g, '&')
          .replace(/&amp;/g, '&');
        const re = /https:\/\/video\.twimg\.com\/[^\s"'\\<>) ]+/g;
        let m;
        while ((m = re.exec(raw))) {
          const u = m[0];
          if (!/\.mp4(\?|$)/.test(u)) continue;
          const vm = /(?:ext_tw_video|amplify_video)\/(\d{5,25})\//.exec(u);
          if (!vm) continue;
          const vid = vm[1];
          if (!groups.has(vid)) groups.set(vid, []);
          if (groups.get(vid).indexOf(u) === -1) groups.get(vid).push(u);
          if (matcher && matcher.test(u) && matched.indexOf(u) === -1) matched.push(u);
        }
      }
    } catch (e) {
      /* ignore */
    }
    if (matched.length) return matched;
    // 兜底：ID 都没匹配上，但整个页面数据里只有一组视频——当前就在推文详情页，
    // 初始内嵌数据几乎只可能是本推文的（若有回复视频会出现多组，此时不猜）
    const groupList = Array.from(groups.values());
    if (groupList.length === 1) return groupList[0];
    return [];
  }

  // 多个分辨率按 URL 里的 /vid/<codec>/<w>x<h>/ 挑最大的，同分辨率优先 avc1(H.264)
  function pickByResolution(urls) {
    let best = null;
    let bestScore = -1;
    for (const u of urls) {
      const m = /\/vid\/[^/]+\/(\d+)x(\d+)\//.exec(u);
      const area = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
      const score = area * 2 + (/\/avc1\//.test(u) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    return best || urls[0] || null;
  }

  // og:video 元信息兜底（详情页 SSR 通常会带，清晰度可能偏低）
  function ogVideoUrl() {
    for (const prop of ['og:video:secure_url', 'og:video:url', 'og:video']) {
      const el = document.querySelector(`meta[property="${prop}"]`);
      const c = el && el.content;
      if (c && /^https:\/\/video\.twimg\.com\//.test(c) && /\.mp4(\?|$)/.test(c)) return c;
    }
    return null;
  }

  // ---------- 与主世界脚本通信，获取视频直链 ----------

  function requestVariants(key) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve([]);
      }, 400);
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.__xpost !== 'media-result') return;
        if (e.data.token !== token || e.data.tweetId !== key) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(Array.isArray(e.data.variants) ? e.data.variants : []);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __xpost: 'get-media', tweetId: key, token }, '*');
    });
  }

  async function videoCandidates(tweetId, posters) {
    const ids = mediaIdsFor(tweetId, posters);
    const matcher = buildMediaIdMatcher(ids);

    // 1) 主世界钩子捕获的接口数据（SPA 跳转 / 回复场景），按码率从高到低
    const buckets = await Promise.all(ids.map((i) => requestVariants(i)));
    const recent = await requestVariants(RECENT_KEY);
    let all = [...buckets.flat(), ...(recent || []).filter((v) => v.url && matcher.test(v.url))];
    const seen = new Set();
    all = all.filter((v) => {
      if (!v.url || seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
    const mp4s = all
      .filter((v) => (v.contentType || '').indexOf('mp4') !== -1 || /\.mp4(\?|$)/.test(v.url))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (mp4s.length) return mp4s.map((v) => v.url);

    // 2) 页面内嵌数据（直接打开详情页：主推文数据 SSR 在 HTML 里）
    const domUrls = videoUrlsFromDom(matcher);
    if (domUrls.length) {
      const best = pickByResolution(domUrls);
      return [best].concat(domUrls.filter((u) => u !== best));
    }

    // 3) 已播放过的视频会出现在资源加载记录里
    const perf = performanceVideoUrls(matcher);
    if (perf.length) return perf;

    // 4) og:video 元信息（清晰度可能偏低）
    const og = ogVideoUrl();
    return og ? [og] : [];
  }

  // ---------- 主流程 ----------

  async function extract(id) {
    const el = findTweetElement(id);
    if (!el) return null;

    const { userName, userId } = parseNameBlock(el.querySelector('[data-testid="User-Name"]'));

    const timeEl = Array.from(el.querySelectorAll('time')).find((t) => !t.closest('[data-testid="quoteTweet"]'));
    const tweetTime = timeEl ? timeEl.getAttribute('datetime') : null;

    const mainText = Array.from(el.querySelectorAll('[data-testid="tweetText"]')).find(
      (t) => !t.closest('[data-testid="quoteTweet"]')
    );
    const content = mainText ? mainText.innerText.trim() : '';

    const title = extractTitle(el);
    const avatarUrl = pickAvatarUrl(el);

    // 图片：正文区内的 pbs 媒体图（排除引用推文里的图）
    const seenImg = new Set();
    const images = Array.from(el.querySelectorAll('img'))
      .filter((im) => !im.closest('[data-testid="quoteTweet"]'))
      .filter((im) => /^https:\/\/pbs\.twimg\.com\/media\//.test(im.src))
      .map((im) => ({
        kind: 'image',
        el: im,
        url: normalizePbs(im.src),
        width: elSize(im).width,
        height: elSize(im).height,
      }))
      .filter((m) => {
        const base = m.url.split('?')[0];
        if (seenImg.has(base)) return false;
        seenImg.add(base);
        return true;
      });

    // 视频：可能有多条（多视频推文），按清晰度从高到低分配直链
    const videoEls = Array.from(el.querySelectorAll('video')).filter((v) => !v.closest('[data-testid="quoteTweet"]'));
    const candidates = await videoCandidates(id, videoEls.map((v) => v.poster));
    const videos = videoEls.map((v) => ({
      kind: 'video',
      el: v,
      url: candidates.length ? candidates.shift() : null,
      poster: v.poster ? normalizePbs(v.poster) : null,
      duration: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
      width: elSize(v).width,
      height: elSize(v).height,
    }));

    // 按页面上的实际顺序（图片/视频混排）排列
    const media = [...images, ...videos].sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );

    // 引用的推文（如有）
    let quoted = null;
    const quoteBox = el.querySelector('[data-testid="quoteTweet"]');
    if (quoteBox) {
      const qName = parseNameBlock(quoteBox.querySelector('[data-testid="User-Name"]'));
      const qText = quoteBox.querySelector('[data-testid="tweetText"]');
      const qLink = quoteBox.querySelector('a[href*="/status/"]');
      let qUrl = '';
      if (qLink) {
        try {
          qUrl = new URL(qLink.getAttribute('href'), location.origin).toString().split('?')[0];
        } catch (e) {
          /* ignore */
        }
      }
      quoted = {
        userName: qName.userName,
        userId: qName.userId,
        content: qText ? qText.innerText.trim() : '',
        url: qUrl,
      };
    }

    const clean = media.map(({ el: _el, ...rest }) => rest);

    return {
      id,
      url: `${location.origin}/${userId || 'i'}/status/${id}`,
      userName,
      userId,
      avatarUrl,
      title,
      content,
      tweetTime,
      quoted,
      media: clean,
    };
  }

  async function capture() {
    try {
      if (!isXSite()) {
        showToast('请在 x.com 的推文页面使用', 'error');
        return;
      }
      const id = tweetIdFromUrl();
      if (!id) {
        showToast('请先打开一条推文的详情页（链接含 /status/）再点击保存', 'error');
        return;
      }
      showToast('正在提取推文…', 'info');

      const payload = await extract(id);
      if (!payload || (!payload.content && !payload.media.length && !payload.quoted)) {
        showToast('未找到推文内容，请等待页面加载完成后重试', 'error');
        return;
      }

      // 交给后台：下载并上传媒体（带进度），全部完成后才提示成功
      showSaving('准备保存…', null);
      try {
        chrome.runtime.sendMessage({ type: 'XPOST_SAVE', payload }, () => void chrome.runtime.lastError);
      } catch (e) {
        showToast('保存失败：' + ((e && e.message) || e), 'error');
      }
    } catch (e) {
      showToast('保存失败：' + ((e && e.message) || e), 'error');
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'XPOST_CAPTURE') {
      capture();
    } else if (msg.type === 'XPOST_PROGRESS') {
      updateSaving(msg.label + (msg.pct != null ? ' · ' + Math.round(msg.pct * 100) + '%' : ''), msg.pct);
    } else if (msg.type === 'XPOST_DONE') {
      if (msg.ok) {
        showToast(msg.duplicate ? '这条推文之前已保存过' : '已保存到 X-Post', 'ok');
      } else {
        showToast('保存失败：' + (msg.error || 'X-Post 应用未运行？'), 'error');
      }
    }
  });
})();

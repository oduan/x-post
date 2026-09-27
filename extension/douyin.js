'use strict';

/**
 * 抖音平台抽取器：抓取作品（视频 / 图文）详情页的
 * 作者昵称 / 抖音号 / 描述 / 发布时间 / 封面 / 视频或图片直链。
 * 数据来源优先级：
 *   1. 主世界脚本 inject-douyin.js 钩住接口捕获的作品详情（SPA 进详情页 / 信息流弹层）
 *   2. 页面内嵌的服务端渲染数据（RENDER_DATA / __pace_f 分片，直接打开详情页的场景）
 *   3. DOM 元素 + Performance 资源记录兜底
 */
(() => {
  if (window.__xpostDouyinLoaded || !window.__xpost) return;
  window.__xpostDouyinLoaded = true;

  const { registerExtractor, elSize } = window.__xpost;

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  // ---------- 页面 / 作品定位 ----------

  function isDouyinSite() {
    return /(^|\.)douyin\.com$/.test(location.hostname);
  }

  // 作品 ID：详情页是 /video/<id> 或 /note/<id>（图文），信息流弹层是 ?modal_id=<id>
  function awemeIdFromUrl() {
    let m = /\/(?:video|note)\/(\d{5,25})/.exec(location.pathname);
    if (m) return m[1];
    m = /modal_id=(\d{5,25})/.exec(location.search);
    if (m) return m[1];
    return null;
  }

  // ---------- 数据字段读取（接口/内嵌数据存在 snake_case 与 camelCase 两种风格） ----------

  function fieldOf(o, snake) {
    if (!o || typeof o !== 'object') return undefined;
    const camel = snake.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());
    if (o[snake] !== undefined) return o[snake];
    if (o[camel] !== undefined) return o[camel];
    return undefined;
  }

  function urlListOf(v) {
    const list = v && (v.url_list || v.urlList);
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
  }

  // 该作品是否带图集信息（多图/动图）
  function hasImageGallery(detail) {
    if (!detail || typeof detail !== 'object') return false;
    const inInfo = fieldOf(fieldOf(detail, 'image_post_info'), 'images');
    if (Array.isArray(inInfo) && inInfo.length) return true;
    const top = fieldOf(detail, 'images'); // 旧版接口：顶层 images 数组
    return Array.isArray(top) && top.length > 0;
  }

  // 图集 → 媒体数组：静态图取 display_image；实况/动图没有静态图、
  // 只有随图视频（play_addr + 封面），保存为带封面的视频项。
  // 注意：图集作品还会带一个把图片串成视频、配上背景音乐的合成视频
  // （顶层 video.play_addr），这里一律不取——只保留图片/随图视频本身。
  function imagesOf(detail) {
    let list = fieldOf(fieldOf(detail, 'image_post_info'), 'images');
    if (!Array.isArray(list) || !list.length) list = fieldOf(detail, 'images');
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const im of list) {
      // display_image 常规结构；旧版顶层 images 的项自带 url_list
      const disp = fieldOf(im, 'display_image') || (fieldOf(im, 'url_list') ? im : null);
      const urls = urlListOf(disp);
      if (urls.length) {
        out.push({
          kind: 'image',
          url: urls[0],
          width: Number(fieldOf(disp, 'width')) || Number(fieldOf(im, 'width')) || 0,
          height: Number(fieldOf(disp, 'height')) || Number(fieldOf(im, 'height')) || 0,
        });
        continue;
      }
      const v = fieldOf(im, 'video');
      const play = urlListOf(fieldOf(v, 'play_addr'))[0];
      if (play) {
        out.push({
          kind: 'video',
          url: play,
          poster: urlListOf(fieldOf(v, 'cover'))[0] || urlListOf(fieldOf(v, 'origin_cover'))[0] || null,
          duration: 0,
          width: Number(fieldOf(v, 'width')) || Number(fieldOf(im, 'width')) || 0,
          height: Number(fieldOf(v, 'height')) || Number(fieldOf(im, 'height')) || 0,
        });
      }
    }
    return out;
  }

  // 普通视频作品的直链与封面（图集作品不会走到这里）。
  // 优先取 bit_rate 里码率最高的流——那是真正的音视频合成 mp4；
  // play_addr 兜底（个别作品会给出纯音频流，下载下来只有声音没有画面）。
  function videoUrlOf(detail) {
    const video = fieldOf(detail, 'video');
    if (!video) return null;
    const rates = fieldOf(video, 'bit_rate');
    if (Array.isArray(rates)) {
      let best = null;
      for (const r of rates) {
        const urls = urlListOf(fieldOf(r, 'play_addr'));
        if (!urls.length) continue;
        const br = Number(fieldOf(r, 'bit_rate')) || 0;
        if (!best || br > best.br) best = { br, url: urls[0] };
      }
      if (best) return best.url;
    }
    for (const key of ['play_addr', 'download_addr']) {
      const urls = urlListOf(fieldOf(video, key));
      if (urls.length) return urls[0];
    }
    return null;
  }

  function coverUrlOf(detail) {
    const video = fieldOf(detail, 'video');
    for (const key of ['cover', 'origin_cover', 'dynamic_cover']) {
      const urls = urlListOf(fieldOf(video, key));
      if (urls.length) return urls[0];
    }
    return null;
  }

  // ---------- 详情数据来源 1：主世界钩子捕获的接口数据 ----------

  function requestDetail(id) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 600);
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.__xpost !== 'douyin-detail') return;
        if (e.data.token !== token || e.data.awemeId !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data.detail || null);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __xpost: 'get-douyin-detail', awemeId: id, token }, '*');
    });
  }

  // ---------- 详情数据来源 2：页面内嵌的服务端渲染数据 ----------

  // 在任意嵌套结构里找 aweme_id 匹配且带媒体的作品对象
  function deepFindAweme(o, id, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 14) return null;
    if ((o.aweme_id === id || o.awemeId === id) && (o.video || o.image_post_info || o.imagePostInfo)) return o;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') {
        const f = deepFindAweme(v, id, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }

  function detailFromScripts(id) {
    // RENDER_DATA：URL 编码的 JSON
    try {
      const el = document.getElementById('RENDER_DATA');
      if (el && el.textContent) {
        const found = deepFindAweme(JSON.parse(decodeURIComponent(el.textContent)), id);
        if (found) return found;
      }
    } catch (e) {
      /* ignore */
    }
    // __pace_f 分片：每个分片是 push 进数组的一段 JSON 字符串，按出现顺序拼接后是完整 JSON
    try {
      const parts = [];
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        if (t.indexOf('__pace_f.push') === -1) continue;
        const m = /self\.__pace_f\.push\(\[\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/.exec(t);
        if (m) parts.push(JSON.parse(m[1]));
      }
      if (parts.length) {
        const found = deepFindAweme(JSON.parse(parts.join('')), id);
        if (found) return found;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // ---------- 兜底：页面源码 / 资源记录里找视频直链 ----------

  // 还原 JSON 转义后再匹配直链（内嵌数据里的 / 常写作 \/ 或 \u002F）
  function unescapeJsonish(t) {
    return t
      .replace(/\\\//g, '/')
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');
  }

  function isPlayUrl(u) {
    return /douyin\.com\/aweme\/v1\/play/.test(u) || /douyinvod\.com\//.test(u) || /^https?:\/\/[^/]+\.douyinpic\.com\/.+\.mp4/.test(u);
  }

  function playUrlsFromSource(raw, uniq) {
    const out = [];
    const re = /https?:\/\/[^\s"'\\<>)]+/g;
    let m;
    while ((m = re.exec(raw))) {
      const u = m[0];
      if (!isPlayUrl(u)) continue;
      if (!uniq.has(u)) {
        uniq.add(u);
        out.push(u);
      }
    }
    return out;
  }

  function fallbackVideoUrls() {
    const uniq = new Set();
    let urls = [];
    try {
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        if (t.indexOf('play') === -1 && t.indexOf('douyinvod') === -1) continue;
        urls = urls.concat(playUrlsFromSource(unescapeJsonish(t), uniq));
      }
    } catch (e) {
      /* ignore */
    }
    if (urls.length) return urls;
    try {
      // 视频播放过则真实直链出现在资源加载记录里
      urls = performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter(isPlayUrl);
    } catch (e) {
      /* ignore */
    }
    return urls;
  }

  // ---------- 兜底：从 DOM 读作者 / 描述 / 封面 ----------

  function domInfo() {
    const out = { userName: '', userId: '', avatarUrl: null, content: '', poster: null };
    const descEl = document.querySelector(
      '[data-e2e="video-desc"], [data-e2e="video-info-desc"], [class*="video-info-desc"], [class*="video-desc"]'
    );
    if (descEl) out.content = (descEl.innerText || descEl.textContent || '').trim();

    // 作者区：昵称 + 抖音号 + 头像。选择器退化到第一个 /user/ 链接（详情页作者区通常就在最前）
    const container =
      document.querySelector('[data-e2e="video-author-info"]') ||
      document.querySelector('[class*="author"]');
    const scope = container || document;
    const nameEl =
      scope.querySelector('[data-e2e="video-author-nickname"]') ||
      scope.querySelector('a[href*="/user/"]');
    if (nameEl) {
      out.userName = (nameEl.getAttribute('title') || nameEl.innerText || '').trim();
      const link = nameEl.matches && nameEl.matches('a[href*="/user/"]') ? nameEl : nameEl.querySelector('a[href*="/user/"]');
      if (!out.userName && link) out.userName = (link.getAttribute('title') || link.innerText || '').trim();
    }
    for (const s of scope.querySelectorAll('span, div')) {
      const m = /抖音号[:：]\s*([A-Za-z0-9._-]{1,40})/.exec(s.textContent || '');
      if (m) {
        out.userId = m[1];
        break;
      }
    }
    const avatarImg = scope.querySelector('a[href*="/user/"] img, [class*="avatar"] img');
    if (avatarImg) out.avatarUrl = avatarImg.currentSrc || avatarImg.src || null;

    const posterEl = document.querySelector('video[poster]');
    if (posterEl) out.poster = posterEl.poster;
    if (!out.poster) {
      const og = document.querySelector('meta[property="og:image"]');
      if (og) out.poster = og.content || null;
    }
    return out;
  }

  // ---------- 组装 ----------

  function buildUrl(id, fromPath) {
    if (fromPath) return location.origin + location.pathname;
    return `https://www.douyin.com/video/${id}`;
  }

  async function extract() {
    const id = awemeIdFromUrl();
    if (!id) return { error: '请先打开抖音的作品详情页（链接含 /video/ 或 /note/）再点击保存' };
    const fromPath = /\/(?:video|note)\/(\d{5,25})/.test(location.pathname);

    // 依次尝试接口捕获 → 内嵌数据；两者都拿到时优先带图集信息的那份
    // （同一作品的 feed 预取详情可能缺 image_post_info，完整详情接口才有）
    let detail = await requestDetail(id);
    const fromScripts = detailFromScripts(id);
    if (fromScripts && (!detail || (!hasImageGallery(detail) && hasImageGallery(fromScripts)))) detail = fromScripts;

    let userName = '';
    let userId = '';
    let authorKey = ''; // 稳定作者键：sec_uid（抖音号/昵称都可改，sec_uid 永远不变）
    let avatarUrl = null;
    let content = '';
    let tweetTime = null;
    let media = [];

    if (detail) {
      const author = fieldOf(detail, 'author') || {};
      userName = str(author.nickname);
      userId = str(author.unique_id || author.short_id || author.sec_uid);
      authorKey = str(author.sec_uid) || userId;
      avatarUrl = urlListOf(fieldOf(author, 'avatar_thumb'))[0] || urlListOf(fieldOf(author, 'avatar_medium'))[0] || null;
      content = str(fieldOf(detail, 'desc')).trim();

      const ct = Number(fieldOf(detail, 'create_time'));
      if (ct > 0) tweetTime = new Date(ct * 1000).toISOString();

      media = imagesOf(detail);
      if (!media.length) {
        const video = fieldOf(detail, 'video') || {};
        const durMs = Number(fieldOf(video, 'duration')) || 0;
        media = [
          {
            kind: 'video',
            url: videoUrlOf(detail),
            poster: coverUrlOf(detail),
            duration: durMs > 0 ? Math.round(durMs / 100) / 10 : 0,
            width: Number(fieldOf(video, 'width')) || 0,
            height: Number(fieldOf(video, 'height')) || 0,
          },
        ];
        if (!media[0].url) {
          const urls = fallbackVideoUrls();
          if (urls.length) media[0].url = urls[0];
        }
      }
    }

    // 内嵌数据缺失（改版/弹层等）时退回 DOM 与源码扫描
    const dom = domInfo();
    if (!userName) userName = dom.userName;
    if (!userId) userId = dom.userId;
    if (!avatarUrl) avatarUrl = dom.avatarUrl;
    if (!content) content = dom.content;

    if (!media.length) {
      const v = document.querySelector('video');
      const urls = fallbackVideoUrls();
      if (v || urls.length) {
        media = [
          {
            kind: 'video',
            url: urls[0] || null,
            poster: dom.poster,
            duration: v && isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
            width: v ? elSize(v).width : 0,
            height: v ? elSize(v).height : 0,
          },
        ];
      } else {
        // 图文作品兜底：正文区里的抖音图床图片
        const seen = new Set();
        media = Array.from(document.querySelectorAll('[data-e2e="video-detail"] img, [class*="swiper"] img'))
          .map((im) => ({ kind: 'image', el: im, url: im.currentSrc || im.src }))
          .filter((m) => /^https?:\/\/[^/]*douyinpic\.com\//.test(m.url))
          .filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)))
          .map((m) => ({ kind: 'image', url: m.url, width: elSize(m.el).width, height: elSize(m.el).height }));
      }
    }
    if (media.length === 1 && media[0].kind === 'video' && !media[0].poster) media[0].poster = dom.poster;

    return {
      payload: {
        platform: 'douyin',
        id,
        authorKey: authorKey || userId,
        url: buildUrl(id, fromPath),
        userName: userName || '抖音用户',
        userId,
        avatarUrl,
        title: '',
        content,
        tweetTime,
        quoted: null,
        media,
      },
    };
  }

  registerExtractor({
    id: 'douyin',
    matches: isDouyinSite,
    extract,
  });
})();

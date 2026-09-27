'use strict';

/**
 * X(Twitter) 平台抽取器：抓取推文详情页的
 * 用户名 / 用户 ID / 标题 / 正文 / 图片 / 视频信息。
 * 视频直链由主世界脚本 inject.js 从接口数据中捕获，这里通过 window.postMessage 查询。
 */
(() => {
  if (window.__xpostXLoaded || !window.__xpost) return;
  window.__xpostXLoaded = true;

  const { registerExtractor, elSize } = window.__xpost;
  const RECENT_KEY = '__recent__';

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

  function performanceVideoUrls(matcher, want) {
    try {
      return performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((u) => u.indexOf('video.twimg.com') !== -1)
        .filter((u) => (want === 'hls' ? /\.m3u8(\?|$)/.test(u) : /\.mp4(\?|$)/.test(u)))
        .filter((u) => !matcher || matcher.test(u));
    } catch (e) {
      return [];
    }
  }

  // 直接打开推文详情页时，主推文数据（含视频直链）内嵌在页面 HTML/内联脚本里，
  // 不经过 GraphQL 接口，需要直接扫描 DOM 里的内联脚本。mp4 与 m3u8 分别收集
  function videoUrlsFromDom(matcher) {
    const mp4Matched = [];
    const hlsMatched = [];
    const hlsAll = new Set();
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
          if (/\.mp4(\?|$)/.test(u)) {
            const vm = /(?:ext_tw_video|amplify_video)\/(\d{5,25})\//.exec(u);
            if (!vm) continue;
            const vid = vm[1];
            if (!groups.has(vid)) groups.set(vid, []);
            if (groups.get(vid).indexOf(u) === -1) groups.get(vid).push(u);
            if (matcher && matcher.test(u) && mp4Matched.indexOf(u) === -1) mp4Matched.push(u);
          } else if (/\.m3u8(\?|$)/.test(u)) {
            hlsAll.add(u);
            if (matcher && matcher.test(u) && hlsMatched.indexOf(u) === -1) hlsMatched.push(u);
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    let mp4 = mp4Matched;
    if (!mp4.length) {
      // 兜底：ID 都没匹配上，但整个页面数据里只有一组视频——当前就在推文详情页，
      // 初始内嵌数据几乎只可能是本推文的（若有回复视频会出现多组，此时不猜）
      const groupList = Array.from(groups.values());
      if (groupList.length === 1) mp4 = groupList[0];
    }
    let hls = hlsMatched;
    if (!hls.length && hlsAll.size === 1) hls = [hlsAll.values().next().value];
    return { mp4, hls };
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

  // 返回 { list: 变体数组, alive: 主世界钩子是否存在 }——
  // alive 用于区分「钩子没在运行（标签页是旧的）」和「钩子在但没等到数据」
  function requestVariants(key) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ list: [], alive: false });
      }, 400);
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.__xpost !== 'media-result') return;
        if (e.data.token !== token || e.data.tweetId !== key) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve({ list: Array.isArray(e.data.variants) ? e.data.variants : [], alive: true });
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __xpost: 'get-media', tweetId: key, token }, '*');
    });
  }

  async function videoCandidates(tweetId, posters, singleVideo, stats) {
    const ids = mediaIdsFor(tweetId, posters);
    const matcher = buildMediaIdMatcher(ids);

    // 1) 主世界钩子捕获的接口数据（SPA 跳转 / 回复场景），按码率从高到低。
    //    alive 区分「钩子不在运行（标签页是旧的）」和「钩子在但没等到数据」
    const buckets = await Promise.all(ids.map((i) => requestVariants(i)));
    const recent = await requestVariants(RECENT_KEY);
    const hookAlive = buckets.some((b) => b.alive) || recent.alive;
    if (stats) {
      stats.hookAlive = hookAlive ? 1 : 0;
      stats.hookRaw = recent.list.length; // 钩子缓冲的变体总数（未按媒体 ID 过滤）
    }
    let all = [...buckets.flatMap((b) => b.list), ...recent.list.filter((v) => v.url && matcher.test(v.url))];
    const seen = new Set();
    all = all.filter((v) => {
      if (!v.url || seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
    const mp4s = all
      .filter((v) => (v.contentType || '').indexOf('mp4') !== -1 || /\.mp4(\?|$)/.test(v.url))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    // mp4 缺失时的 HLS 候选（部分视频——尤其受限推文——只有 m3u8）
    const hlsList = all
      .filter((v) => /\.m3u8(\?|$)/.test(v.url) || (v.contentType || '').indexOf('mpegurl') !== -1)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (stats) {
      stats.hookTotal = all.length;
      stats.hookMp4 = mp4s.length;
      stats.hookM3u8 = hlsList.length;
    }
    if (mp4s.length) return { urls: mp4s.map((v) => v.url), hlsUrl: null };

    // 2) 页面内嵌数据（直接打开详情页：主推文数据 SSR 在 HTML 里）
    const dom = videoUrlsFromDom(matcher);
    if (stats) {
      stats.domMp4 = dom.mp4.length;
      stats.domM3u8 = dom.hls.length;
    }
    if (dom.mp4.length) {
      const best = pickByResolution(dom.mp4);
      return { urls: [best].concat(dom.mp4.filter((u) => u !== best)), hlsUrl: null };
    }

    // 3) 已播放过的视频会出现在资源加载记录里
    const perf = performanceVideoUrls(matcher, 'mp4');
    if (stats) stats.perfMp4 = perf.length;
    if (perf.length) return { urls: perf, hlsUrl: null };

    // 4) og:video 元信息（清晰度可能偏低）
    const og = ogVideoUrl();
    if (stats) stats.og = og ? 1 : 0;
    if (og) return { urls: [og], hlsUrl: null };

    // 5) 全部 mp4 路径落空 → HLS 候选（钩子匹配 → 内嵌 → 播放记录）
    if (hlsList.length) return { urls: [], hlsUrl: hlsList[0].url };
    if (dom.hls.length) return { urls: [], hlsUrl: dom.hls[0] };
    const perfHls = performanceVideoUrls(matcher, 'hls');
    if (stats) stats.perfHls = perfHls.length;
    if (perfHls.length) return { urls: [], hlsUrl: perfHls[perfHls.length - 1] };

    // 6) 最后手段：详情页只有一个视频时，钩子缓冲里未匹配的最新 mp4 大概率就是它
    //    （ID 规则变化、broadcast 等场景）
    if (singleVideo) {
      const lastResort = recent.list
        .filter((v) => v.url && /\.mp4(\?|$)/.test(v.url))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (stats) stats.lastResort = lastResort.length;
      if (lastResort.length) return { urls: [lastResort[0].url], hlsUrl: null };
    }
    return { urls: [], hlsUrl: null };
  }

  // 直链可能尚未就绪：刚打开详情页/视频还没开始加载时，接口数据与资源记录都还是空的。
  // 空结果时短暂轮询（总共约 2.4s），等 GraphQL 响应/视频加载到位再试。
  // 始终返回各捕获路径的统计（stats），失败时用于在卡片上显示原因
  async function videoCandidatesWithRetry(tweetId, posters, singleVideo, attempts = 4) {
    const stats = {
      hookAlive: 0,
      hookRaw: 0,
      hookTotal: 0,
      hookMp4: 0,
      hookM3u8: 0,
      domMp4: 0,
      domM3u8: 0,
      perfMp4: 0,
      perfHls: 0,
      og: 0,
      lastResort: 0,
    };
    for (let i = 0; i < attempts; i++) {
      const s = {};
      const r = await videoCandidates(tweetId, posters, singleVideo, s);
      Object.assign(stats, s);
      if (r.urls.length || r.hlsUrl) return { ...r, stats };
      if (i < attempts - 1) await new Promise((r2) => setTimeout(r2, 800));
    }
    return { urls: [], hlsUrl: null, stats };
  }

  // ---------- 抽取 ----------

  async function extract() {
    const id = tweetIdFromUrl();
    if (!id) return { error: '请先打开一条推文的详情页（链接含 /status/）再点击保存' };

    const el = findTweetElement(id);
    if (!el) return { error: '未找到推文内容，请等待页面加载完成后重试' };

    const { userName, userId } = parseNameBlock(el.querySelector('[data-testid="User-Name"]'));

    const timeEl = Array.from(el.querySelectorAll('time')).find((t) => !t.closest('[data-testid="quoteTweet"]'));
    const tweetTime = timeEl ? timeEl.getAttribute('datetime') : null;

    const mainText = Array.from(el.querySelectorAll('[data-testid="tweetText"]')).find(
      (t) => !t.closest('[data-testid="quoteTweet"]')
    );
    const content = mainText ? mainText.innerText.trim() : '';

    const title = extractTitle(el);
    const avatarUrl = pickAvatarUrl(el);

    // 图片：正文区内的 pbs 媒体图（排除引用推文与视频播放器——
    // 播放器加载后会把自己的封面渲染成 <img>，amplify 视频的封面恰好走 /media/ 图床路径）
    const seenImg = new Set();
    const images = Array.from(el.querySelectorAll('img'))
      .filter((im) => !im.closest('[data-testid="quoteTweet"]'))
      .filter((im) => !im.closest('[data-testid="videoComponent"]'))
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
    const { urls: candidates, hlsUrl, stats: vstats } = await videoCandidatesWithRetry(
      id,
      videoEls.map((v) => v.poster),
      videoEls.length === 1
    );
    const videos = videoEls.map((v, idx) => {
      const hasMp4 = candidates.length > idx;
      const entry = {
        kind: 'video',
        el: v,
        url: hasMp4 ? candidates[idx] : null,
        // HLS 候选只挂到第一个视频（多视频且都 HLS 的推文极少见）
        hlsUrl: !hasMp4 && idx === 0 ? hlsUrl || null : null,
        poster: v.poster ? normalizePbs(v.poster) : null,
        duration: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
        width: elSize(v).width,
        height: elSize(v).height,
      };
      // 直链与 HLS 都没有：记录各捕获路径的统计，卡片上显示原因
      if (!entry.url && !entry.hlsUrl && vstats) {
        entry.missReason =
          `未捕获直链(钩子${vstats.hookAlive ? '活' : '无'}·原始${vstats.hookRaw}·匹配${vstats.hookTotal}:` +
          `mp4 ${vstats.hookMp4}/hls ${vstats.hookM3u8}·内嵌 ${vstats.domMp4}+${vstats.domM3u8}` +
          `·播放 ${vstats.perfMp4}+${vstats.perfHls}·og ${vstats.og}` +
          (vstats.lastResort ? `·兜底${vstats.lastResort}` : '') +
          ')';
      }
      return entry;
    });

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
      payload: {
        platform: 'x',
        id,
        authorKey: userId,
        url: `${location.origin}/${userId || 'i'}/status/${id}`,
        userName,
        userId,
        avatarUrl,
        title,
        content,
        tweetTime,
        quoted,
        media: clean,
      },
    };
  }

  registerExtractor({
    id: 'x',
    matches: isXSite,
    extract,
  });
})();

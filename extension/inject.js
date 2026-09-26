'use strict';

/**
 * 注入到页面主世界（MAIN world）的脚本：
 * X 的推文数据通过 GraphQL/XHR 接口异步加载，视频的直链（mp4 variants）
 * 只存在于这些接口的 JSON 响应里（页面里的 <video> 是 blob: 地址，无法直接下载）。
 * 本脚本在 document_start 钩住 fetch / XMLHttpRequest，捕获含 video_info
 * 的响应，按推文 ID 缓存视频直链，供内容脚本通过 window.postMessage 查询。
 */
(() => {
  if (window.__xpostHookInstalled) return;
  window.__xpostHookInstalled = true;

  const variantsByTweet = {}; // tweetId -> [{url, contentType, bitrate}]
  const RECENT_KEY = '__recent__';

  function addVariants(id, list) {
    if (!id || !Array.isArray(list) || !list.length) return;
    const cur = variantsByTweet[id] || (variantsByTweet[id] = []);
    for (const v of list) {
      if (v && v.url && !cur.some((x) => x.url === v.url)) cur.push(v);
    }
  }

  function tweetIdFromRequest(url) {
    try {
      const decoded = decodeURIComponent(String(url));
      let m = /"tweet_id"\s*:\s*"(\d{5,25})"/.exec(decoded);
      if (m) return m[1];
      m = /tweet_id=(\d{5,25})/.exec(decoded);
      if (m) return m[1];
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // 视频直链本身包含推文 ID，如 video.twimg.com/ext_tw_video/<tweetId>/pu/vid/...
  function tweetIdFromMediaUrl(u) {
    const m = /video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d{5,25})\//.exec(String(u));
    return m ? m[1] : null;
  }

  function collectVariants(json) {
    const found = [];
    const visit = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.video_info && Array.isArray(o.video_info.variants)) {
        found.push(
          o.video_info.variants
            .filter((v) => v && (v.src || v.url))
            .map((v) => ({ url: v.src || v.url, contentType: v.content_type || '', bitrate: v.bitrate || 0 }))
        );
      }
      for (const k in o) visit(o[k]);
    };
    visit(json);
    return found.flat();
  }

  function handleBody(text, reqUrl) {
    if (!text || text.indexOf('video_info') === -1) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    const list = collectVariants(json);
    if (!list.length) return;
    const reqId = tweetIdFromRequest(reqUrl || '');
    if (reqId) addVariants(reqId, list);
    for (const v of list) {
      const mid = tweetIdFromMediaUrl(v.url);
      if (mid && mid !== reqId) addVariants(mid, [v]);
    }
    addVariants(RECENT_KEY, list);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.apply(this, arguments);
      if (url.indexOf('/i/api/') !== -1 || url.indexOf('twimg.com') !== -1) {
        p.then((resp) => {
          try {
            resp
              .clone()
              .text()
              .then((t) => handleBody(t, url))
              .catch(() => {});
          } catch (e) {
            /* ignore */
          }
        }).catch(() => {});
      }
      return p;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    function PatchedXHR() {
      const xhr = new OrigXHR();
      let reqUrl = '';
      const open = xhr.open;
      xhr.open = function (method, url) {
        reqUrl = String(url);
        return open.apply(xhr, arguments);
      };
      xhr.addEventListener('load', function () {
        try {
          const ct = xhr.getResponseHeader('content-type') || '';
          if (ct.indexOf('json') !== -1) handleBody(xhr.responseText, reqUrl);
        } catch (e) {
          /* ignore */
        }
      });
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  }

  // 响应内容脚本（隔离世界）的查询
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__xpost !== 'get-media') return;
    const key = e.data.tweetId;
    window.postMessage({ __xpost: 'media-result', tweetId: key, token: e.data.token, variants: variantsByTweet[key] || [] }, '*');
  });
})();

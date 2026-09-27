'use strict';

/**
 * 注入到抖音页面主世界（MAIN world）的脚本：
 * 抖音的作品详情（作者、描述、封面、视频直链）通过 XHR 接口异步加载，
 * 从信息流点进详情页 / 打开弹层时页面里的 <video> 是 blob 地址，无法直接下载。
 * 本脚本在 document_start 钩住 fetch / XMLHttpRequest，捕获含作品数据
 * （aweme_detail / item_list）的 JSON 响应，按作品 ID（aweme_id）缓存，
 * 供内容脚本通过 window.postMessage 查询。
 */
(() => {
  if (window.__xpostDouyinHookInstalled) return;
  window.__xpostDouyinHookInstalled = true;

  const detailsById = {}; // awemeId -> 作品详情对象

  // 是否带图集（多图/动图）信息：feed 预取的详情可能缺这块，只有完整详情接口才有
  function hasGallery(a) {
    return !!a && !!a.image_post_info;
  }

  function pushDetail(a) {
    if (!a || typeof a !== 'object') return;
    const id = String(a.aweme_id || a.awemeId || '');
    if (!id) return;
    const hasImages = Array.isArray(a.images) && a.images.length > 0; // 旧版接口：顶层 images
    if (!a.video && !a.image_post_info && !a.imagePostInfo && !hasImages) return;
    const cur = detailsById[id];
    // 同一作品捕获到多条时，优先保留带图集信息的完整详情
    if (!cur || (hasGallery(a) && !hasGallery(cur))) detailsById[id] = a;
  }

  // 深度遍历响应：兼容 aweme_detail 包装与 feed/search 的 item_list 数组
  function collect(json) {
    const visit = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 14) return;
      if (Array.isArray(o)) {
        for (const x of o) visit(x, depth + 1);
        return;
      }
      if (o.aweme_detail) pushDetail(o.aweme_detail);
      pushDetail(o);
      for (const k in o) visit(o[k], depth + 1);
    };
    visit(json, 0);
  }

  function handleBody(text) {
    if (!text) return;
    if (
      text.indexOf('aweme_detail') === -1 &&
      text.indexOf('item_list') === -1 &&
      text.indexOf('play_addr') === -1 &&
      text.indexOf('playAddr') === -1
    ) {
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    collect(json);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.apply(this, arguments);
      // 只盯作品相关接口，避免解析无关大响应
      if (url.indexOf('/aweme/') !== -1) {
        p.then((resp) => {
          try {
            resp
              .clone()
              .text()
              .then(handleBody)
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
          if (reqUrl.indexOf('/aweme/') === -1) return;
          const ct = xhr.getResponseHeader('content-type') || '';
          if (ct.indexOf('json') !== -1 || !ct) handleBody(xhr.responseText);
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
    if (e.source !== window || !e.data || e.data.__xpost !== 'get-douyin-detail') return;
    const id = String(e.data.awemeId || '');
    window.postMessage({ __xpost: 'douyin-detail', awemeId: id, token: e.data.token, detail: detailsById[id] || null }, '*');
  });
})();

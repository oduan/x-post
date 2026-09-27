'use strict';

/**
 * 内容脚本公共框架（与各平台抽取器 x.js / douyin.js 共用同一个隔离世界）：
 *  - 页面内临时提示（toast）
 *  - 平台抽取器的注册与分发：点击扩展图标后按当前站点选择抽取器，
 *    抽取得到的元信息交给后台脚本发送给本地 X-Post 应用
 *  - 接收后台的进度 / 结果消息并更新提示
 */
(() => {
  if (window.__xpostContentLoaded) return;
  window.__xpostContentLoaded = true;

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

  // ---------- 各平台抽取器共用的小工具 ----------

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

  // ---------- 平台抽取器注册与主流程 ----------

  // 抽取器：{ id, matches(): boolean, extract(): Promise<{payload}|{error}> }
  const extractors = [];

  function registerExtractor(ex) {
    extractors.push(ex);
  }

  async function capture() {
    try {
      const ex = extractors.find((e) => {
        try {
          return e.matches();
        } catch (err) {
          return false;
        }
      });
      if (!ex) {
        showToast('请在 X(Twitter) 推文详情页或抖音作品详情页使用', 'error');
        return;
      }
      showToast('正在提取内容…', 'info');

      const res = await ex.extract();
      if (!res || res.error) {
        showToast((res && res.error) || '未找到内容，请等待页面加载完成后重试', 'error');
        return;
      }
      const payload = res.payload;
      if (!payload || (!payload.content && !(payload.media && payload.media.length) && !payload.quoted)) {
        showToast('未找到内容，请等待页面加载完成后重试', 'error');
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
        showToast(msg.duplicate ? '这条内容之前已保存过' : '已保存到 X-Post', 'ok');
      } else {
        showToast('保存失败：' + (msg.error || 'X-Post 应用未运行？'), 'error');
      }
    }
  });

  // 平台抽取器（x.js / douyin.js）与框架同处一个隔离世界，通过该命名空间取用共享能力
  window.__xpost = { registerExtractor, showToast, elSize };
})();

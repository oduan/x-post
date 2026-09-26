'use strict';

const api = window.xpost;

const PAGE_SIZE = 50; // 每页推文数（无限滚动按页加载）
const RENDER_CHUNK = 80; // 切回已缓存的视图时分帧渲染的每帧卡片数
const MAX_USER_CACHES = 12; // 最多保留多少个用户视图的分页缓存（防内存无限增长）

const els = {
  timeline: document.getElementById('timeline'),
  count: document.getElementById('count'),
  empty: document.getElementById('empty'),
  settings: document.getElementById('settings'),
  settingsDir: document.getElementById('settings-dir'),
  settingsMeta: document.getElementById('settings-meta'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnFolder: document.getElementById('btn-folder'),
  btnSettings: document.getElementById('btn-settings'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnChoose: document.getElementById('btn-choose-dir'),
  btnOpenDir: document.getElementById('btn-open-dir'),
  btnBack: document.getElementById('btn-back'),
  viewName: document.getElementById('view-name'),
  lightbox: document.getElementById('lightbox'),
  lbMedia: document.getElementById('lb-media'),
  lbCount: document.getElementById('lb-count'),
  lbPrev: document.getElementById('lb-prev'),
  lbNext: document.getElementById('lb-next'),
  lbClose: document.getElementById('lb-close'),
};

let view = { type: 'timeline' }; // 当前视图：{type:'timeline'} 或 {type:'user', userId, userName}
const carouselState = new Map(); // tweetId -> 卡片内轮播当前下标

// ---------- 视图状态（分页缓存） ----------
// 每个视图一份：items 为已加载的推文（按各自视图的排序键降序），配合
// IntersectionObserver 哨兵元素按页追加；切走时缓存保留（含滚动位置），
// 切回时直接从缓存分帧重绘，无需重新读库到原位置。
const viewStates = new Map(); // viewKey -> state
let active = null; // 当前展示中的视图状态
let activeSeq = 0; // 每次切换视图/刷新递增，用于丢弃过期的异步渲染

function viewKey(v) {
  return v && v.type === 'user' ? 'user:' + v.userId : 'timeline';
}

function getState(v) {
  const k = viewKey(v);
  let s = viewStates.get(k);
  if (!s) {
    s = {
      view: { type: v.type === 'user' ? 'user' : 'timeline', userId: v.userId, userName: v.userName },
      items: [], // 已加载推文（含 _keys 排序键）
      byId: new Map(),
      nextCursor: null,
      total: 0,
      loading: false,
      done: false, // 已到末页
      rendering: false, // 正在分帧重绘缓存（此间只改数组不动 DOM）
      scrollY: 0,
    };
    if (s.view.type === 'user') evictOldUserCaches();
    viewStates.set(k, s);
  } else {
    // 触摸即视为最近使用（Map 按插入序做简易 LRU）
    viewStates.delete(k);
    viewStates.set(k, s);
  }
  return s;
}

function evictOldUserCaches() {
  let users = [...viewStates.entries()].filter(([k, s]) => s.view.type === 'user' && s !== active);
  while (users.length >= MAX_USER_CACHES) {
    const [k] = users.shift(); // 最旧的
    viewStates.delete(k);
    users = [...viewStates.entries()].filter(([e, s]) => s.view.type === 'user' && s !== active);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天';
  return d.toLocaleDateString('zh-CN');
}

function abs(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}

// ---------- 视图切换 ----------

function setView(v) {
  const nextKey = viewKey(v);
  if (active && viewKey(active.view) === nextKey) return; // 已在该视图
  if (active) active.scrollY = window.scrollY; // 保存当前视图的位置
  view = v;
  active = getState(v);
  renderView();
}

function renderViewTitle() {
  if (view.type === 'user') {
    els.btnBack.hidden = false;
    els.viewName.textContent = view.userName ? `${view.userName}（@${view.userId}）` : `@${view.userId}`;
  } else {
    els.btnBack.hidden = true;
    els.viewName.textContent = 'X-Post';
  }
}

function updateCount() {
  if (!active) {
    els.count.textContent = '';
    return;
  }
  els.count.textContent = active.total > 0 || !active.loading ? `${active.total} 条` : '';
}

// ---------- 卡片渲染 ----------

function userAttrs(t) {
  return t.userId
    ? ` data-user-id="${esc(t.userId)}" data-user-name="${esc(t.userName || '')}"`
    : '';
}

function avatarHtml(t) {
  const inner = t.avatarUrl
    ? `<img class="avatar" src="${esc(t.avatarUrl)}" alt="">`
    : `<div class="avatar avatar-fallback">${esc((t.userName || '?').trim().charAt(0) || '?')}</div>`;
  if (t.userId) return `<span class="user-link avatar-link"${userAttrs(t)}>${inner}</span>`;
  return inner;
}

function mediaItemHtml(m, idx) {
  if (!m) return '';
  const dataIdx = `data-idx="${idx}"`;
  if (m.kind === 'image') {
    const src = m.localUrl || m.url;
    return src ? `<div class="media-item"${dataIdx}><img src="${esc(src)}" alt="" loading="lazy"></div>` : '';
  }
  const src = m.localUrl || m.url;
  const poster = m.posterLocalUrl || m.poster || '';
  if (src) {
    return (
      `<div class="media-item media-video"${dataIdx}>` +
      `<video src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ''} preload="metadata"></video>` +
      '<div class="video-play"><button class="video-play-btn" title="播放">▶</button></div></div>'
    );
  }
  if (poster) {
    return (
      `<div class="media-item media-video"${dataIdx}><img src="${esc(poster)}" alt="" loading="lazy">` +
      '<div class="video-play"><span>▶</span></div><span class="miss-note">未捕获到视频直链，已保存封面</span></div>'
    );
  }
  return '';
}

// 媒体条带：所有媒体等高（占满条带高度），横向一个接一个排列成胶片条。
// 项宽由 bindStripBox 用 JS 按宽高比直接设为像素值——Chromium 对 flex 子项上的
// 嵌套 min()/calc() 宽度解析不可靠，不能用 CSS 表达式。
// 已知宽高比的项带 data-aspect；未知（旧数据）带 data-need-aspect，加载后回填。
function stripItemAttrs(m) {
  const w = m && m.width;
  const h = m && m.height;
  if (w > 0 && h > 0) return ` data-aspect="${(w / h).toFixed(4)}"`;
  return ' data-need-aspect="1"';
}

function mediaHtml(t) {
  const list = t.media || [];
  if (!list.length) return '';
  // 固定高度的横向条带：媒体按各自宽高比并排排列，箭头逐项切换（X 风格）
  const items = list.map((m, i) => `<div class="strip-item"${stripItemAttrs(m)}>${mediaItemHtml(m, i)}</div>`).join('');
  const track = `<div class="strip-track">${items}</div>`;
  if (list.length === 1) return `<div class="media strip single" data-id="${esc(t.id)}">${track}</div>`;
  const dots = list.map(() => `<span class="car-dot"></span>`).join('');
  return (
    `<div class="media strip" data-id="${esc(t.id)}">${track}` +
    '<button class="car-btn car-prev">‹</button>' +
    '<button class="car-btn car-next">›</button>' +
    `<div class="car-pill">${dots}</div></div>`
  );
}

function quoteHtml(t) {
  const q = t.quotedTweet;
  if (!q || (!q.userName && !q.content)) return '';
  const nameAttrs = q.userId ? ` class="quote-name user-link"${userAttrs(q)}` : ' class="quote-name"';
  const head = `<div class="quote-head"><span${nameAttrs}>${esc(q.userName || '')}</span>${
    q.userId ? `<span class="quote-handle user-link"${userAttrs(q)}>@${esc(q.userId)}</span>` : ''
  }</div>`;
  const body = q.content ? `<div class="quote-text">${esc(q.content)}</div>` : '';
  return `<div class="quote">${head}${body}</div>`;
}

function tweetHtml(t) {
  const timeIso = t.tweetTime || t.savedAt;
  return `
  <article class="tweet" data-id="${esc(t.id)}">
    ${avatarHtml(t)}
    <div class="tweet-body">
      <div class="tweet-head">
        <span class="tweet-name${t.userId ? ' user-link' : ''}"${userAttrs(t)}>${esc(t.userName || '未知用户')}</span>
        ${t.userId ? `<span class="tweet-handle user-link"${userAttrs(t)}>@${esc(t.userId)}</span>` : ''}
        <span class="dot">·</span>
        <span class="tweet-time" title="${esc(abs(timeIso))}">${esc(rel(timeIso))}</span>
        <button class="more-btn" data-id="${esc(t.id)}" title="更多选项">⋯</button>
      </div>
      ${t.title ? `<div class="tweet-title">${esc(t.title)}</div>` : ''}
      ${t.content ? `<div class="tweet-text">${esc(t.content)}</div>` : ''}
      ${mediaHtml(t)}
      ${quoteHtml(t)}
    </div>
  </article>`;
}

function buildCard(t) {
  const wrap = document.createElement('div');
  wrap.innerHTML = tweetHtml(t);
  return wrap.firstElementChild;
}

// ---------- 列表渲染（分页 + 无限滚动） ----------

let sentinelEl = null;
let io = null;

function clearHints() {
  els.timeline.querySelectorAll('.hint').forEach((h) => h.remove());
}

function showHint(text, cls) {
  clearHints();
  const div = document.createElement('div');
  div.className = 'hint' + (cls ? ' ' + cls : '');
  div.textContent = text;
  els.timeline.appendChild(div);
  hideSentinel();
}

function ensureSentinel() {
  if (!sentinelEl || !els.timeline.contains(sentinelEl)) {
    if (sentinelEl) sentinelEl.remove();
    sentinelEl = document.createElement('div');
    sentinelEl.id = 'page-sentinel';
    els.timeline.appendChild(sentinelEl);
    if (io) io.observe(sentinelEl);
  }
}

function hideSentinel() {
  if (sentinelEl) sentinelEl.hidden = true;
}

function updateSentinel(s) {
  ensureSentinel();
  if (s.done) {
    sentinelEl.hidden = true;
  } else if (s.loading) {
    sentinelEl.hidden = false;
    sentinelEl.textContent = '加载中…';
  } else {
    sentinelEl.hidden = false;
    sentinelEl.textContent = '';
  }
}

if ('IntersectionObserver' in window) {
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting) && active && !active.loading && !active.done && !active.rendering) {
        loadPage(active);
      }
    },
    { rootMargin: '800px' }
  );
}

// 展示某个视图：无缓存则拉首页；有缓存（从别的视图切回）分帧重绘后恢复滚动位置
function renderView() {
  activeSeq++;
  const seq = activeSeq;
  renderViewTitle();
  updateCount();
  els.timeline.innerHTML = '';
  els.empty.hidden = true;
  if (io && sentinelEl) io.unobserve(sentinelEl);
  sentinelEl = null;

  if (!active.items.length) {
    if (!active.done) {
      showHint('加载中…');
      loadPage(active, seq);
    } else {
      els.empty.hidden = false;
    }
    return;
  }
  renderItemsChunked(active, seq, () => {
    window.scrollTo(0, active.scrollY || 0);
  });
  // 顺带刷新该视图的总数（后台可能有增量变化）
  refreshCount(seq);
}

function renderItemsChunked(s, seq, done) {
  s.rendering = true;
  els.timeline.innerHTML = '';
  let i = 0;
  const step = () => {
    if (seq !== activeSeq || s !== active) {
      s.rendering = false;
      return; // 期间切走了视图，本轮绘制作废
    }
    const frag = document.createDocumentFragment();
    const cards = [];
    const end = Math.min(s.items.length, i + RENDER_CHUNK);
    for (; i < end; i++) {
      const card = buildCard(s.items[i]);
      cards.push(card);
      frag.appendChild(card);
    }
    els.timeline.appendChild(frag);
    // 插入 DOM 后再绑条带（绑定需读取真实 clientWidth，见 loadPage 注释）
    cards.forEach(bindStripCard);
    if (i < s.items.length) {
      requestAnimationFrame(step);
    } else {
      s.rendering = false;
      ensureSentinel();
      updateSentinel(s);
      if (done) done();
    }
  };
  step();
}

async function loadPage(s, seq) {
  if (!s || s.loading || s.done) return;
  s.loading = true;
  if (s === active) updateSentinel(s);
  try {
    const resp = await api.pageTweets({
      view: s.view.type,
      userId: s.view.type === 'user' ? s.view.userId : undefined,
      cursor: s.nextCursor,
      limit: PAGE_SIZE,
    });
    for (const t of resp.items || []) {
      s.items.push(t);
      s.byId.set(t.id, t);
    }
    s.total = resp.total != null ? resp.total : s.total;
    s.nextCursor = resp.nextCursor || null;
    if (!s.nextCursor) s.done = true;
    if (s === active && seq === activeSeq && !s.rendering) {
      clearHints();
      els.empty.hidden = true;
      // 先插入 DOM 再绑条带：绑定时要读 clientWidth 计算媒体宽度，
      // 脱离文档的元素读到 0，会把所有条带项压到 120px 下限
      const cards = (resp.items || []).map((t) => buildCard(t));
      const frag = document.createDocumentFragment();
      cards.forEach((c) => frag.appendChild(c));
      ensureSentinel();
      els.timeline.insertBefore(frag, sentinelEl);
      cards.forEach(bindStripCard);
      updateSentinel(s);
      if (s.done && !s.items.length) {
        els.timeline.innerHTML = '';
        els.empty.hidden = false;
      }
    }
  } catch (e) {
    if (s === active && seq === activeSeq) {
      showHint('读取数据失败：' + ((e && e.message) || e), 'error');
    }
  } finally {
    s.loading = false;
    updateCount();
    if (s !== active) return;
    if (seq !== activeSeq) {
      // 请求期间视图被刷新/切换过：缓存可能已合并本次结果但 DOM 没渲染，
      // 补一次渲染或首页加载，避免停留在「加载中…」
      if (s.items.length && !els.timeline.querySelector('.tweet')) {
        renderItemsChunked(s, activeSeq, () => {});
      } else if (!s.items.length && !s.done) {
        loadPage(s, activeSeq);
      }
      return;
    }
    if (s === active && seq === activeSeq) {
      updateSentinel(s); // loading 已复位：哨兵文案从「加载中…」恢复为待命状态
      if (!s.done && sentinelEl && !sentinelEl.hidden) {
        // 内容不足一屏或哨兵仍可见时继续加载
        const r = sentinelEl.getBoundingClientRect();
        if (r.top < window.innerHeight + 800) loadPage(s, seq);
      }
    }
  }
}

async function refreshCount(seq) {
  if (!active) return;
  try {
    const total = await api.countTweets({ view: active.view.type, userId: active.view.userId });
    if (seq === activeSeq && active) {
      active.total = total;
      updateCount();
    }
  } catch (e) {
    /* 计数失败不影响列表 */
  }
}

// 刷新：重置当前视图缓存，回到顶部重新加载
function refresh() {
  if (!active) return;
  active.items = [];
  active.byId = new Map();
  active.nextCursor = null;
  active.total = 0;
  active.done = false;
  active.scrollY = 0;
  renderView();
}

// ---------- 增量更新（来自主进程的 upsert / delete 事件） ----------

function cmpKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function applyUpsert(t) {
  if (!t || !t.id || !t._keys) return;
  upsertInto(viewStates.get('timeline'), t, 'timeline'); // 时间线缓存始终维护
  if (t.userId) {
    const us = viewStates.get('user:' + t.userId);
    if (us) upsertInto(us, t, 'user');
  }
  updateCount();
}

function upsertInto(s, t, kind) {
  if (!s) return;
  const existing = s.byId.get(t.id);
  if (existing) {
    // 兜底下载回填等更新：排序键不变（savedAt 固定），原地替换
    Object.assign(existing, t);
    if (s === active && !s.rendering) replaceCard(existing);
    return;
  }
  const key = t._keys[kind];
  if (!key) return;
  let i = s.items.length;
  while (i > 0 && cmpKeys(key, s.items[i - 1]._keys[kind]) > 0) i--;
  s.items.splice(i, 0, t);
  s.byId.set(t.id, t);
  s.total++;
  if (s === active && !s.rendering) {
    clearHints();
    els.empty.hidden = true;
    insertCardAt(i, t);
    updateSentinel(s);
  }
}

function insertCardAt(i, t) {
  const card = buildCard(t);
  ensureSentinel();
  const ref = els.timeline.children[i] || sentinelEl;
  els.timeline.insertBefore(card, ref);
  bindStripCard(card); // 插入 DOM 后再绑（需读真实 clientWidth）
}

function replaceCard(t) {
  const node = els.timeline.querySelector(`.tweet[data-id="${CSS.escape(t.id)}"]`);
  if (!node) return;
  const fresh = buildCard(t);
  node.replaceWith(fresh);
  bindStripCard(fresh); // 插入 DOM 后再绑（需读真实 clientWidth）
}

function applyDelete(id) {
  for (const s of viewStates.values()) {
    if (s.byId.delete(id)) {
      const i = s.items.findIndex((x) => x.id === id);
      if (i >= 0) s.items.splice(i, 1);
      s.total = Math.max(0, s.total - 1);
      if (s === active) {
        const node = els.timeline.querySelector(`.tweet[data-id="${CSS.escape(id)}"]`);
        if (node) node.remove();
        if (!s.items.length) {
          s.done = true;
          els.timeline.innerHTML = '';
          els.empty.hidden = false;
        }
      }
    }
  }
  updateCount();
}

api.onChanged((p) => {
  if (!p || p.event === 'reload') {
    refresh();
    return;
  }
  if (p.event === 'upsert' && p.tweet) applyUpsert(p.tweet);
  else if (p.event === 'delete' && p.id) applyDelete(p.id);
});

// ---------- 媒体条带绑定 ----------

// 当前显示的是哪个条带项（最贴近滚动位置的项；各项宽度不同，不能按宽度均分计算）
function currentStripIdx(track) {
  const sl = track.scrollLeft;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < track.children.length; i++) {
    const d = Math.abs(track.children[i].offsetLeft - sl);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// 为卡片内的媒体条带设置项宽（等高、按宽高比）、绑定滚动同步，并恢复上次的页码
function bindStripCard(card) {
  if (!card) return;
  card.querySelectorAll('.media.strip').forEach(bindStripBox);
}

function bindStripBox(box) {
  const track = box.querySelector('.strip-track');
  if (!track) return;
  const count = track.children.length;

  const stripHeight = () => Math.min(380, window.innerHeight * 0.5);

  const applyWidth = (item, aspect) => {
    if (!(aspect > 0)) return;
    const trackW = track.clientWidth;
    const w = Math.max(120, Math.min(trackW, stripHeight() * aspect));
    item.style.width = Math.round(w) + 'px';
  };

  box.querySelectorAll('.strip-item').forEach((item) => {
    if (item.dataset.aspect) {
      applyWidth(item, parseFloat(item.dataset.aspect));
    } else if (item.dataset.needAspect) {
      // 未记录尺寸的旧数据：加载出真实尺寸后按宽高比设置
      const apply = (w, h) => {
        if (!(w > 0 && h > 0)) return;
        applyWidth(item, w / h);
        delete item.dataset.needAspect;
        alignTo(carouselState.get(box.dataset.id) || 0);
        sync();
      };
      const img = item.querySelector('img');
      const vid = item.querySelector('video');
      if (img) {
        if (img.complete && img.naturalWidth) apply(img.naturalWidth, img.naturalHeight);
        else img.addEventListener('load', () => apply(img.naturalWidth, img.naturalHeight), { once: true });
      } else if (vid) {
        if (vid.videoWidth) apply(vid.videoWidth, vid.videoHeight);
        else vid.addEventListener('loadedmetadata', () => apply(vid.videoWidth, vid.videoHeight), { once: true });
      }
    }
  });

  // 视频播放状态驱动 ▶ 遮罩显隐；播放后显示原生底部控件；控件全屏按钮转为窗口内全屏
  box.querySelectorAll('.media-item').forEach((item) => {
    const v = item.querySelector('video');
    if (!v) return;
    v.addEventListener('play', () => {
      lastMediaToggleAt.set(v, performance.now());
      v.controls = true; // 点击播放后，视频底部出现控件（同全屏样式）
      item.classList.add('playing');
    });
    v.addEventListener('pause', () => {
      lastMediaToggleAt.set(v, performance.now());
      item.classList.remove('playing');
    });
    v.addEventListener('ended', () => {
      v.currentTime = 0;
      item.classList.remove('playing');
    });
    // 窗口禁止系统全屏（fullscreenable:false），控件里的全屏按钮触发的是
    // Chromium 元素全屏：视频直接铺满应用窗口（无窗口切换、不闪烁），
    // 再点一次即退出回到卡片，均为原生行为，无需拦截。
    // 只有控件里的全屏按钮能切换全屏，屏蔽双击视频触发的原生全屏
    v.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  const saved = carouselState.get(box.dataset.id) || 0;
  const alignTo = (i) => {
    const idx = Math.max(0, Math.min(count - 1, i));
    if (track.children[idx]) track.scrollLeft = track.children[idx].offsetLeft;
  };
  const sync = () => {
    const idx = Math.max(0, Math.min(count - 1, currentStripIdx(track)));
    carouselState.set(box.dataset.id, idx);
    box.querySelectorAll('.car-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
    const prev = box.querySelector('.car-prev');
    const next = box.querySelector('.car-next');
    if (prev) prev.style.display = track.scrollLeft <= 1 ? 'none' : '';
    if (next) {
      const maxScroll = track.scrollWidth - track.clientWidth;
      next.style.display = track.scrollLeft >= maxScroll - 1 ? 'none' : '';
    }
  };
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });

  if (saved > 0 && saved < count) alignTo(saved);
  sync();
}

// 窗口尺寸变化时按新宽度重算项宽（rAF 去抖），并按记住的页码重新对齐
let resizeQueued = false;
window.addEventListener('resize', () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const stripHeight = Math.min(380, window.innerHeight * 0.5);
    document.querySelectorAll('.media.strip').forEach((box) => {
      const track = box.querySelector('.strip-track');
      if (!track) return;
      const trackW = track.clientWidth;
      box.querySelectorAll('.strip-item').forEach((item) => {
        const aspect = parseFloat(item.dataset.aspect);
        if (aspect > 0) item.style.width = Math.round(Math.max(120, Math.min(trackW, stripHeight * aspect))) + 'px';
      });
      const idx = carouselState.get(box.dataset.id) || 0;
      if (track.children[idx]) track.scrollLeft = track.children[idx].offsetLeft;
    });
  });
});

// ---------- 设置 ----------

async function renderSettings() {
  const c = await api.getConfig().catch(() => null);
  if (!c) return;
  els.settingsDir.textContent = c.dataDir || '';
  els.settingsMeta.textContent = `数据库：${c.dbFile || ''}\n配置文件：${c.configPath}    本地端口：127.0.0.1:${c.port}`;
}

// ---------- 窗口级媒体查看器（lightbox） ----------

const lb = { tweet: null, index: 0, resumeTime: 0 };

function openLightbox(t, index, resumeTime) {
  if (!t || !t.media || !t.media.length) return;
  // 暂停所有原地播放中的视频，避免与全屏播放重叠出声
  document.querySelectorAll('.media-item video').forEach((v) => {
    if (!v.paused) v.pause();
  });
  lb.tweet = t;
  lb.index = Math.max(0, Math.min(t.media.length - 1, index));
  lb.resumeTime = resumeTime > 0 ? resumeTime : 0;
  lbRender();
  els.lightbox.hidden = false;
}

function closeLightbox() {
  lb.tweet = null;
  els.lbMedia.innerHTML = '';
  els.lightbox.hidden = true;
}

function lbRender() {
  const t = lb.tweet;
  if (!t || !t.media || !t.media.length) return closeLightbox();
  const m = t.media[lb.index];
  if (m.kind === 'image') {
    const src = m.localUrl || m.url;
    els.lbMedia.innerHTML = src ? `<img src="${esc(src)}" alt="">` : '';
  } else {
    const src = m.localUrl || m.url;
    const poster = m.posterLocalUrl || m.poster || '';
    if (src) {
      els.lbMedia.innerHTML = `<video src="${esc(src)}" ${
        poster ? `poster="${esc(poster)}"` : ''
      } controls autoplay></video>`;
      // 原地播放过的视频，全屏从原进度继续
      const vEl = els.lbMedia.querySelector('video');
      if (vEl) {
        // 查看器里点控件的全屏按钮 = 元素全屏铺满窗口（原生行为），再点退出回到查看器
        // 双击不触发系统全屏
        vEl.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        if (lb.resumeTime > 0) {
          const t0 = lb.resumeTime;
          vEl.addEventListener(
            'loadedmetadata',
            () => {
              try {
                vEl.currentTime = t0;
              } catch (e) {
                /* ignore */
              }
            },
            { once: true }
          );
        }
      }
    } else if (poster) {
      els.lbMedia.innerHTML = `<img src="${esc(poster)}" alt="">`;
    } else {
      els.lbMedia.innerHTML = '';
    }
  }
  els.lbCount.textContent = `${lb.index + 1} / ${t.media.length}`;
  els.lbPrev.hidden = lb.index <= 0;
  els.lbNext.hidden = lb.index >= t.media.length - 1;
}

function lbStep(d) {
  if (!lb.tweet) return;
  lb.index = Math.max(0, Math.min(lb.tweet.media.length - 1, lb.index + d));
  lbRender();
}

els.lbPrev.addEventListener('click', (e) => {
  e.stopPropagation();
  lbStep(-1);
});
els.lbNext.addEventListener('click', (e) => {
  e.stopPropagation();
  lbStep(1);
});
els.lbClose.addEventListener('click', closeLightbox);
els.lightbox.addEventListener('click', (e) => {
  if (e.target === els.lightbox) closeLightbox();
});

// ---------- 推文右上角 ⋯ 菜单 ----------

let menuEl = null;

function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

function openTweetMenu(btn, id) {
  closeMenu();
  const t = active && active.byId.get(id);
  menuEl = document.createElement('div');
  menuEl.className = 'tweet-menu';

  const addItem = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.className = 'tweet-menu-item' + (cls ? ' ' + cls : '');
    b.textContent = label;
    if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    menuEl.appendChild(b);
    return b;
  };

  if (t && t.url) addItem('打开原推文', '', () => { closeMenu(); api.openExternal(t.url); });
  if (t) addItem(`保存于 ${abs(t.savedAt)}`, 'info');

  if (menuEl.children.length) {
    const sep = document.createElement('div');
    sep.className = 'tweet-menu-sep';
    menuEl.appendChild(sep);
  }

  addItem('删除', 'danger', async () => {
    closeMenu();
    if (!window.confirm('确定删除这条推文吗？其保存的图片/视频文件也会一并删除。')) return;
    try {
      await api.deleteTweet(id);
    } catch (err) {
      window.alert('删除失败：' + ((err && err.message) || err));
    }
    // 增量 delete 事件会移除卡片；这里兜底立即移除
    if (active && active.byId.has(id)) applyDelete(id);
  });

  document.body.appendChild(menuEl);

  const r = btn.getBoundingClientRect();
  const mw = menuEl.offsetWidth || 200;
  const mh = menuEl.offsetHeight || 160;
  menuEl.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - mh - 8)) + 'px';
  menuEl.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
}

// ---------- 事件 ----------

els.btnRefresh.addEventListener('click', refresh);
els.btnFolder.addEventListener('click', () => api.openDataDir());
els.btnOpenDir.addEventListener('click', () => api.openDataDir());
els.btnBack.addEventListener('click', () => setView({ type: 'timeline' }));

els.btnSettings.addEventListener('click', () => {
  renderSettings();
  els.settings.hidden = false;
});
els.btnCloseSettings.addEventListener('click', () => {
  els.settings.hidden = true;
});
els.settings.addEventListener('click', (e) => {
  if (e.target === els.settings) els.settings.hidden = true;
});

els.btnChoose.addEventListener('click', async () => {
  const c = await api.chooseDataDir();
  if (c) {
    // 数据目录已切换：全部视图缓存作废
    viewStates.clear();
    view = { type: 'timeline' };
    active = getState(view);
    renderView();
    els.settings.hidden = true;
  }
});

// 记录 pointerdown 时视频的播放状态，以及视频最近一次播放/暂停切换的时刻，
// 用于识别原生控件的播放/暂停点击（见时间线点击处理），避免二次切换
const pausedAtPointerDown = new WeakMap();
const lastMediaToggleAt = new WeakMap();
document.addEventListener(
  'pointerdown',
  (e) => {
    const item = e.target instanceof Element && e.target.closest('.media-item');
    const v = item && item.querySelector('video');
    if (v) pausedAtPointerDown.set(v, v.paused);
  },
  true
);

// 时间线内的统一点击处理：⋯ 菜单 / 轮播翻页 / 视频播放暂停 / 图片放大 / 跳转用户主页
els.timeline.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;

  const more = target.closest('.more-btn');
  if (more) {
    e.stopPropagation();
    openTweetMenu(more, more.dataset.id);
    return;
  }

  const carBtn = target.closest('.car-btn');
  if (carBtn) {
    e.stopPropagation();
    const box = carBtn.closest('.media');
    const track = box && box.querySelector('.strip-track');
    if (track && track.children.length) {
      // 各条带项宽度不同（按媒体宽高比），逐项定位切换
      const cur = currentStripIdx(track);
      const targetIdx = Math.max(0, Math.min(track.children.length - 1, cur + (carBtn.classList.contains('car-next') ? 1 : -1)));
      track.scrollTo({ left: track.children[targetIdx].offsetLeft, behavior: 'smooth' });
    }
    return;
  }

  // 点击 ▶ 按钮：原地播放（尺寸不变），不走全屏
  const playBtn = target.closest('.video-play-btn');
  if (playBtn) {
    const item = playBtn.closest('.media-item');
    const v = item && item.querySelector('video');
    if (v) {
      e.stopPropagation();
      v.play().catch(() => {});
      return;
    }
    // 无视频（仅封面）时继续走点击放大的逻辑
  }

  const item = target.closest('.media-item');
  if (item) {
    const v = item.querySelector('video');
    if (v) {
      // 视频：点击空白处切换播放/暂停（首次点击即开始播放并显示控件）；
      // 底部原生控件条区域的点击交给控件本身；全屏只通过控件里的全屏按钮
      // （元素全屏原生行为，见 bindStripBox 注释）。
      const r = v.getBoundingClientRect();
      const inControlsBar = r.height > 90 && e.clientY > r.bottom - 52;
      // 按下→抬起期间播放状态若已被原生控件切换（如点了控件里的暂停/播放），
      // 或本次点击前 200ms 内状态刚被切换过（原生按钮动作与本处理存在时序竞态），
      // 均不再由这里二次切换，否则会出现「暂停后立刻又播放」
      const wasPaused = pausedAtPointerDown.get(v);
      const stateChangedSinceDown = wasPaused !== undefined && wasPaused !== v.paused;
      const toggledJustNow = performance.now() - (lastMediaToggleAt.get(v) || 0) < 200;
      if (!inControlsBar && !stateChangedSinceDown && !toggledJustNow) {
        // 阻止 Chromium 原生「单击带 controls 的视频表面 = 切换播放」的默认行为——
        // 否则这里暂停后，原生默认动作会立即把它切回播放
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      }
      return;
    }
    const article = item.closest('.tweet');
    const id = article && article.dataset.id;
    const t = active && active.byId.get(id);
    if (t && t.media && t.media.length) {
      openLightbox(t, parseInt(item.dataset.idx, 10) || 0);
    }
    return;
  }

  const userLink = target.closest('.user-link');
  if (userLink && userLink.dataset.userId) {
    setView({ type: 'user', userId: userLink.dataset.userId, userName: userLink.dataset.userName || '' });
  }
});

document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
  const a = e.target instanceof Element && e.target.closest('a[data-external]');
  if (a) {
    e.preventDefault();
    api.openExternal(a.href);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
    els.settings.hidden = true;
  } else if (!els.lightbox.hidden && e.key === 'ArrowLeft') {
    lbStep(-1);
  } else if (!els.lightbox.hidden && e.key === 'ArrowRight') {
    lbStep(1);
  }
});

// ---------- 启动 ----------

active = getState(view);
renderView();

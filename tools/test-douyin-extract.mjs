// 抖音抽取逻辑离线测试：在 vm 沙盒里执行真实的 inject-douyin.js + douyin.js，
// 模拟 window 消息总线 / XHR / DOM，验证图集（多图/动图+背景音乐）等场景。
// 用法：node tools/test-douyin-extract.mjs
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readExt = (f) => fs.readFileSync(path.join(root, 'extension', f), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond || extra == null ? '' : ' —— ' + JSON.stringify(extra)));
  if (!cond) failures++;
}

/**
 * 建一个沙盒：加载 inject-douyin.js 与 douyin.js，返回 { extract, respondXhr }。
 * location.pathname 决定作品 ID（/video/<id>）。
 */
function makeSandbox({ pathname }) {
  const listeners = [];
  const scripts = []; // document.querySelectorAll('script') 的返回
  let innerWin = null; // vm 内部的全局视图（postMessage 的 e.source 必须与脚本内的 window 全等）
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance: { getEntriesByType: () => [] },
    location: { hostname: 'www.douyin.com', origin: 'https://www.douyin.com', pathname, search: '' },
    // window === 全局：消息总线同步投递（模拟真实 postMessage 往返）
    addEventListener: (type, l) => {
      if (type === 'message') listeners.push(l);
    },
    removeEventListener: (type, l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (data) => {
      for (const l of [...listeners]) l({ source: innerWin, data });
    },
    // inject-douyin.js 在 document_start 读取 window.XMLHttpRequest；测试里手工触发 load
    XMLHttpRequest: class {
      constructor() {
        this._ls = {};
        this.responseText = '';
      }
      open(m, u) {
        this._url = String(u);
      }
      addEventListener(t, cb) {
        (this._ls[t] = this._ls[t] || []).push(cb);
      }
      getResponseHeader() {
        return 'application/json';
      }
      respond(text) {
        this.responseText = text;
        (this._ls.load || []).forEach((cb) => cb());
      }
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'script' ? scripts : []),
    },
  };
  sandbox.window = sandbox;
  sandbox.__xpost = {
    registerExtractor: (ex) => {
      sandbox.__extractor = ex;
    },
    showToast: () => {},
    elSize: () => ({ width: 0, height: 0 }),
  };
  const ctx = vm.createContext(sandbox);
  innerWin = vm.runInContext('globalThis', ctx); // e.source 与脚本内 window 全等
  vm.runInContext(readExt('inject-douyin.js'), ctx, { filename: 'inject-douyin.js' });
  vm.runInContext(readExt('douyin.js'), ctx, { filename: 'douyin.js' });
  return {
    extract: (expr) => sandbox.__extractor.extract(expr),
    // 模拟页面发出一个 /aweme/ JSON 接口响应
    respondXhr: (obj) => {
      const x = new sandbox.XMLHttpRequest();
      x.open('GET', 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123');
      x.respond(JSON.stringify(obj));
    },
    setScripts: (texts) => {
      scripts.length = 0;
      for (const t of texts) scripts.push({ textContent: t });
    },
  };
}

const img = (i) => ({
  display_image: {
    url_list: [`https://p3-sign.douyinpic.com/img/${i}~c5_1080x1440.webp`],
    width: 1080,
    height: 1440,
  },
  width: 1080,
  height: 1440,
});

// 图集作品的完整详情：多图 + 顶层 video（图片串成的合成视频）+ music（背景音乐）
function galleryDetail(id, n, camel = false) {
  const d = {
    aweme_id: id,
    desc: `图集测试作品 #${n}图`,
    create_time: 1759000000,
    author: { nickname: '图集作者', unique_id: 'gallery_user', avatar_thumb: { url_list: ['https://p3-sign.douyinpic.com/aweme-avatar/a.jpg'] } },
    music: { play_url: { url_list: ['https://sf3-dycdn-tos.pstatp.com/obj/tos-cn-ve-15c489-sv/music.mp3'] } },
  };
  const images = [];
  for (let i = 1; i <= n; i++) images.push(img(i));
  const mediaField = camel ? 'imagePostInfo' : 'image_post_info';
  const imagesField = camel ? 'images' : 'images';
  d[mediaField] = { [imagesField]: images };
  // 合成视频（幻灯片）：图集详情里通常也存在，不应被抓取
  d.video = {
    play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=slideshow&line=0'] },
    cover: { url_list: ['https://p3-sign.douyinpic.com/slideshow-cover.jpg'] },
    duration: 15000,
    width: 1080,
    height: 1440,
  };
  return d;
}

// ===== 场景 1：接口捕获的完整详情（snake_case）=====
{
  const id = '7345000000000000101';
  const sb = makeSandbox({ pathname: '/video/' + id });
  sb.respondXhr({ aweme_detail: galleryDetail(id, 3) });
  const p = (await sb.extract()).payload;
  check('图集: platform 为 douyin', p.platform === 'douyin');
  check('图集: 保留全部 3 张图片', p.media.length === 3 && p.media.every((m) => m.kind === 'image'), p.media);
  check('图集: 图片 URL 来自 display_image', p.media[0].url.includes('/img/1~'));
  check('图集: 不抓合成视频与背景音乐', !p.media.some((m) => m.kind === 'video'));
  check('图集: 作者/描述/时间正常', p.userName === '图集作者' && p.userId === 'gallery_user' && p.tweetTime === '2025-09-27T19:06:40.000Z', p);
  check('图集: 无 sec_uid 时 authorKey 回退展示 ID', p.authorKey === 'gallery_user', p);
}

// ===== 场景 2：camelCase 变体 =====
{
  const id = '7345000000000000102';
  const sb = makeSandbox({ pathname: '/video/' + id });
  sb.respondXhr({ aweme_detail: galleryDetail(id, 2, true) });
  const p = (await sb.extract()).payload;
  check('图集 camelCase: 保留 2 张图片', p.media.length === 2 && p.media.every((m) => m.kind === 'image'), p.media);
}

// ===== 场景 3：页面内嵌数据（__pace_f SSR 分片），hook 无数据 =====
{
  const id = '7345000000000000103';
  const sb = makeSandbox({ pathname: '/note/' + id });
  const detail = galleryDetail(id, 4);
  sb.setScripts(['noise', 'self.__pace_f.push([1,' + JSON.stringify(JSON.stringify({ aweme_detail: detail })) + '])']);
  const p = (await sb.extract()).payload;
  check('图集 SSR: 保留 4 张图片', p.media.length === 4 && p.media.every((m) => m.kind === 'image'), p.media);
}

// ===== 场景 4：hook 先拿到缺图集的预取详情，随后完整详情到达 → 取带图集的 =====
{
  const id = '7345000000000000104';
  const sb = makeSandbox({ pathname: '/video/' + id });
  sb.respondXhr({
    aweme_detail: {
      aweme_id: id,
      desc: '预取（缺图集信息，只有合成视频）',
      author: { nickname: '预取作者', unique_id: 'prefetch_user' },
      video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=slideshow2'] }, cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] } },
    },
  });
  sb.respondXhr({ aweme_detail: galleryDetail(id, 5) }); // 同一作品的完整详情（feed 里先后到达）
  const p = (await sb.extract()).payload;
  check('详情合并: 带图集的完整详情胜出', p.media.length === 5 && p.media.every((m) => m.kind === 'image'), p.media);
}

// ===== 场景 5：旧版接口顶层 images 数组 =====
{
  const id = '7345000000000000105';
  const sb = makeSandbox({ pathname: '/note/' + id });
  sb.respondXhr({
    aweme_detail: {
      aweme_id: id,
      desc: '旧版顶层 images',
      author: { nickname: '旧版作者', unique_id: 'legacy_user' },
      images: [img(1), img(2)],
    },
  });
  const p = (await sb.extract()).payload;
  check('顶层 images: 保留 2 张图片', p.media.length === 2 && p.media.every((m) => m.kind === 'image'), p.media);
}

// ===== 场景 6：实况/动图（无静态图，随图视频带封面）=====
{
  const id = '7345000000000000106';
  const sb = makeSandbox({ pathname: '/note/' + id });
  sb.respondXhr({
    aweme_detail: {
      aweme_id: id,
      desc: '实况图集',
      author: { nickname: '实况作者', unique_id: 'live_user' },
      image_post_info: {
        images: [
          img(1),
          {
            width: 1080,
            height: 1440,
            video: {
              play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=livephoto'] },
              cover: { url_list: ['https://p3-sign.douyinpic.com/live-cover.jpg'] },
              width: 1080,
              height: 1440,
            },
          },
        ],
      },
    },
  });
  const p = (await sb.extract()).payload;
  check('实况图集: 图 1 为 image、图 2 为带封面的 video', p.media.length === 2 && p.media[0].kind === 'image' && p.media[1].kind === 'video' && p.media[1].poster.includes('live-cover'), p.media);
}

// ===== 场景 7：普通视频作品不受影响 =====
{
  const id = '7345000000000000107';
  const sb = makeSandbox({ pathname: '/video/' + id });
  sb.respondXhr({
    aweme_detail: {
      aweme_id: id,
      desc: '普通视频',
      create_time: 1759000000,
      author: { nickname: '视频作者', unique_id: 'video_user' },
      video: {
        play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=realvideo'] },
        cover: { url_list: ['https://p3-sign.douyinpic.com/v-cover.jpg'] },
        duration: 21300,
        width: 1080,
        height: 1920,
      },
    },
  });
  const p = (await sb.extract()).payload;
  check('普通视频: 1 个视频项、直链与时长正确', p.media.length === 1 && p.media[0].kind === 'video' && p.media[0].url.includes('realvideo') && p.media[0].duration === 21.3, p.media);
}

// ===== 场景 8：bit_rate 码率流优先——play_addr 是纯音频流时不能拿它当视频 =====
{
  const id = '7345000000000000108';
  const sb = makeSandbox({ pathname: '/video/' + id });
  sb.respondXhr({
    aweme_detail: {
      aweme_id: id,
      desc: '音频流陷阱',
      author: { nickname: '码率作者', unique_id: 'bitrate_user' },
      video: {
        play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=audio-only'] }, // 实际是 M4A 音频
        cover: { url_list: ['https://p3-sign.douyinpic.com/b-cover.jpg'] },
        bit_rate: [
          { bit_rate: 544211, play_addr: { url_list: ['https://v26-web.douyinvod.com/low/stream.mp4'] } },
          { bit_rate: 2198842, play_addr: { url_list: ['https://v26-web.douyinvod.com/high/stream.mp4'] } },
        ],
      },
    },
  });
  const p = (await sb.extract()).payload;
  check('bit_rate: 取最高码率合成流而非音频流', p.media.length === 1 && p.media[0].kind === 'video' && p.media[0].url.includes('/high/stream.mp4'), p.media);
}

// ===== 场景 9：作者 ID 优先抖音号（unique_id）→ short_id → sec_uid（完整入库，显示端再截断）=====
{
  const secUid = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwxyz0123456789abcdefghij';

  const withUniqueId = makeSandbox({ pathname: '/video/7345000000000000109' });
  withUniqueId.respondXhr({
    aweme_detail: {
      aweme_id: '7345000000000000109',
      desc: '抖音号优先',
      author: { nickname: '有抖音号', unique_id: 'dy_nickname_2024', short_id: '3712345678901234567', sec_uid: secUid },
      video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=v9'] } },
    },
  });
  const p1 = (await withUniqueId.extract()).payload;
  check('作者 ID: 优先用抖音号 unique_id', p1.userId === 'dy_nickname_2024', p1);
  check('作者键: 永远以 sec_uid 为准', p1.authorKey === secUid, p1);

  const shortOnly = makeSandbox({ pathname: '/video/7345000000000000110' });
  shortOnly.respondXhr({
    aweme_detail: {
      aweme_id: '7345000000000000110',
      desc: '无抖音号',
      author: { nickname: '无抖音号', unique_id: '', short_id: '3712345678901234567', sec_uid: secUid },
      video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=v10'] } },
    },
  });
  const p2 = (await shortOnly.extract()).payload;
  check('作者 ID: 无抖音号时用 short_id', p2.userId === '3712345678901234567', p2);
  check('作者键: sec_uid 兜底不变', p2.authorKey === secUid, p2);

  const secOnly = makeSandbox({ pathname: '/video/7345000000000000111' });
  secOnly.respondXhr({
    aweme_detail: {
      aweme_id: '7345000000000000111',
      desc: '只有 sec_uid',
      author: { nickname: '只有sec', unique_id: '', short_id: '', sec_uid: secUid },
      video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=v11'] } },
    },
  });
  const p3 = (await secOnly.extract()).payload;
  check('作者 ID: 只有 sec_uid 时完整保留（显示端截断）', p3.userId === secUid, p3);
  check('作者键: 与展示 ID 一致', p3.authorKey === secUid, p3);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过 ✓');
process.exit(failures ? 1 : 0);

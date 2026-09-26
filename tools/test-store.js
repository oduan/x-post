'use strict';

/**
 * 离线集成测试（不依赖网络外网）：
 *   1. 预置旧版 tweets/*.json 存档，验证首次启动自动迁移进 SQLite 数据库
 *   2. 启动本地 HTTP 服务模拟图片/视频源（用于应用端兜底下载路径）
 *   3. 模拟扩展新流程：先 POST /api/media 上传二进制，再 POST /api/tweets 提交元信息
 *   4. 验证暂存文件移入正式目录、时间线记录立即带本地路径、重复保存去重、旧版扩展（仅 URL）兜底
 *   5. 验证 keyset 分页（时间线/用户视图）与增量变更事件
 * 用法：node tools/test-store.js
 * 说明：better-sqlite3 按 Electron ABI 编译，纯 Node 下无法加载；
 *       脚本会自动用 Electron 运行时启动自身（tools/test-app）执行。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  // Windows 上 electron.exe 首进程可能立即返回（真实应用进程 detached 运行），
  // 直接取子进程退出码不可靠——改为「完成标记文件 + 轮询」协议：
  // 测试端把结果写进 test-store-run.log，结束时写 test-store-done.json。
  const { spawn } = require('child_process');
  const fsShim = require('fs');
  const electronBin = require('../electron-app/node_modules/electron'); // 纯 Node 下返回 electron 可执行文件路径
  const doneFile = path.join(__dirname, 'test-store-done.json');
  try {
    fsShim.unlinkSync(doneFile);
  } catch (e) {
    /* ignore */
  }
  const child = spawn(electronBin, [path.join(__dirname, 'test-app')], {
    stdio: 'ignore',
    detached: true,
    env: process.env,
  });
  child.unref();
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + 180000;
  let done = null;
  while (Date.now() < deadline) {
    sleep(250);
    try {
      done = JSON.parse(fsShim.readFileSync(doneFile, 'utf8'));
      break;
    } catch (e) {
      /* 未结束，继续等 */
    }
  }
  if (!done) {
    console.error('测试超时或未正常结束（3 分钟内没有完成标记）');
    process.exit(1);
  }
  process.exit(done.code ? 1 : 0);
}

const { createTweetStore } = require('../electron-app/lib/store');
const { startServer } = require('../electron-app/lib/server');

// GUI Electron 进程的 stdout 在部分环境下捕获不到，结果同时落盘一份；
// 结束时写 test-store-done.json 通知外层（node 启动器）轮询结束
const LOG_FILE = path.join(__dirname, 'test-store-run.log');
const DONE_FILE = path.join(__dirname, 'test-store-done.json');
try {
  fs.writeFileSync(LOG_FILE, '');
  fs.rmSync(DONE_FILE, { force: true });
} catch (e) {
  /* ignore */
}
const tee = (line) => {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    /* ignore */
  }
};

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    tee('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    console.log('PASS: ' + msg);
    tee('PASS: ' + msg);
  }
}

async function main() {
  // ---------- 模拟媒体源（应用端兜底下载用） ----------
  const fakeJpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
  const fakeMp4 = Buffer.alloc(64 * 1024, 9);
  const origin = http.createServer((req, res) => {
    if (req.url.startsWith('/img')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(fakeJpg);
    } else if (req.url.startsWith('/vid')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(fakeMp4);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${origin.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-test-'));

  // ---------- 预置旧版 JSON 存档（用于迁移测试） ----------
  const LEGACY_ID = '1000000000000000001';
  fs.mkdirSync(path.join(dataDir, 'tweets'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'tweets', LEGACY_ID + '.json'),
    JSON.stringify({
      id: LEGACY_ID,
      url: `https://x.com/legacy_user/status/${LEGACY_ID}`,
      userName: '旧版用户',
      userId: 'legacy_user',
      avatar: null,
      title: '',
      content: 'legacy json archive tweet',
      tweetTime: '2026-01-01T00:00:00.000Z',
      savedAt: '2026-01-02T00:00:00.000Z',
      quotedTweet: null,
      media: [{ kind: 'image', url: 'https://example.com/l.jpg', path: null, width: 10, height: 10 }],
    })
  );
  fs.writeFileSync(path.join(dataDir, 'tweets', 'broken.json'), '{oops'); // 损坏文件应被跳过

  const changes = [];
  const store = await createTweetStore(dataDir, (event, data) => changes.push({ event, data }));

  // ---------- 迁移结果 ----------
  assert(store.page({ view: 'timeline', limit: 10 }).total === 1, '旧版 JSON 存档已导入数据库');
  const legacy = store.get(LEGACY_ID);
  assert(!!legacy && legacy.content === 'legacy json archive tweet' && legacy.userId === 'legacy_user', '迁移后的记录字段完整');
  const dirEntries = fs.readdirSync(dataDir);
  assert(!dirEntries.includes('tweets'), '旧 tweets 目录已改名');
  assert(dirEntries.some((d) => d.startsWith('tweets.bak-')), '旧 tweets 目录保留为 tweets.bak-*');
  assert(fs.existsSync(path.join(dataDir, 'xpost.db')), '数据库文件 xpost.db 已创建');

  // 再次创建（模拟重启）：不再重复迁移
  const store2 = await createTweetStore(dataDir, () => {});
  assert(store2.page({ view: 'timeline', limit: 10 }).total === 1, '重启后不重复迁移');
  assert(fs.readdirSync(dataDir).filter((d) => d.startsWith('tweets.bak-')).length === 1, '备份目录只有一份');
  store2.close();

  // ---------- 本地 HTTP 接口 ----------
  const api = startServer(
    0,
    (payload) => store.saveTweet(payload),
    (info) => store.uploadMedia(info),
    (id) => store.existsTweet(id)
  );
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;

  const postJson = (pathName, obj) =>
    fetch(`${apiUrl}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    }).then((r) => r.json());

  // ---------- 基础接口 ----------
  const ping = await fetch(`${apiUrl}/api/ping`).then((r) => r.json());
  assert(ping.ok === true, 'GET /api/ping 返回 ok');

  const bad = await fetch(`${apiUrl}/api/tweets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert(bad.status === 400, 'POST 非法 JSON 返回 400');

  // ---------- 新流程：先上传媒体二进制，再提交元信息 ----------
  const T1 = '1234567890123456789';
  const imgBin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096, 3)]); // png 魔数
  const vidBin = Buffer.alloc(128 * 1024, 5);

  const up = (index, role, ext, ct, buf) =>
    fetch(`${apiUrl}/api/media`, {
      method: 'POST',
      headers: {
        'Content-Type': ct,
        'X-Tweet-Id': T1,
        'X-Media-Index': String(index),
        'X-Media-Role': role,
        'X-Media-Ext': ext,
      },
      body: buf,
    }).then((r) => r.json());

  const upImg = await up(1, 'main', '.png', 'image/png', imgBin);
  assert(upImg.ok === true, 'POST /api/media 上传图片');
  const upVid = await up(2, 'main', '.mp4', 'video/mp4', vidBin);
  assert(upVid.ok === true, 'POST /api/media 上传视频');
  const upPoster = await up(2, 'poster', '.jpg', 'image/jpeg', imgBin);
  assert(upPoster.ok === true, 'POST /api/media 上传视频封面');

  const badUp = await fetch(`${apiUrl}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', 'X-Tweet-Id': 'abc', 'X-Media-Index': '1' },
    body: vidBin,
  });
  assert(badUp.status === 400, '非法媒体上传请求返回 400');

  // exists 查重：上传暂存期间推文还不存在
  const ex1 = await fetch(`${apiUrl}/api/tweets/exists?id=${T1}`).then((r) => r.json());
  assert(ex1.ok === true && ex1.exists === false, 'exists: 尚未保存时为 false');

  const payload1 = {
    id: T1,
    url: `https://x.com/test_user/status/${T1}`,
    userName: '测试用户',
    userId: 'test_user',
    avatarUrl: `${base}/img1.jpg?format=jpg&name=400x400`,
    title: '',
    content: '你好，世界！这是一条测试推文。\n第二行内容',
    tweetTime: '2026-09-20T00:00:00.000Z',
    quoted: null,
    media: [
      { kind: 'image', url: `${base}/img1.jpg?format=jpg&name=orig`, width: 1200, height: 800 },
      { kind: 'video', url: 'https://example.com/v.mp4', poster: 'https://example.com/p.jpg', duration: 12.3 },
    ],
  };
  const r1 = await postJson('/api/tweets', payload1);
  assert(r1.ok === true && r1.duplicate === false, '提交元信息成功');

  const ex2 = await fetch(`${apiUrl}/api/tweets/exists?id=${T1}`).then((r) => r.json());
  assert(ex2.exists === true, 'exists: 保存后为 true');

  const r2 = await postJson('/api/tweets', payload1);
  assert(r2.ok === true && r2.duplicate === true, '重复保存返回 duplicate');

  // 元信息入库时媒体路径应立即就位（来自暂存），不等兜底下载
  const rec1 = store.get(T1);
  assert(!!rec1, '能读取已保存推文');
  assert(rec1 && rec1.media[0] && rec1.media[0].path === `media/images/${T1}-1.png`, '图片暂存文件立即移入正式目录');
  assert(rec1 && rec1.media[1] && rec1.media[1].path === `media/videos/${T1}-2.mp4`, '视频暂存文件立即移入正式目录');
  assert(rec1 && rec1.media[1] && rec1.media[1].posterPath === `media/images/${T1}-2-poster.jpg`, '封面暂存文件立即移入正式目录');
  assert(fs.existsSync(path.join(dataDir, 'media', 'images', `${T1}-1.png`)), '图片文件存在且为 png 扩展名');
  assert(
    fs.readFileSync(path.join(dataDir, 'media', 'videos', `${T1}-2.mp4`)).length === vidBin.length,
    '视频文件内容完整'
  );
  const stagingLeft = fs.readdirSync(path.join(dataDir, '.staging')).filter((f) => f.startsWith(T1 + '-'));
  assert(stagingLeft.length === 0, '暂存区已清理');

  // 头像走应用端兜底下载，稍后出现
  let avatarOk = false;
  for (let i = 0; i < 50 && !avatarOk; i++) {
    await new Promise((r) => setTimeout(r, 200));
    avatarOk = !!(store.get(T1) || {}).avatar;
  }
  assert(avatarOk, '头像由应用端兜底下载完成');

  // ---------- 旧版流程：仅 URL，应用端兜底下载 ----------
  const T2 = '1112223334445556666';
  const payload2 = {
    id: T2,
    url: `https://x.com/old_ext/status/${T2}`,
    userName: '旧版扩展',
    userId: 'old_ext',
    content: 'fallback download test',
    media: [{ kind: 'image', url: `${base}/img2.jpg?format=jpg&name=orig`, width: 100, height: 100 }],
  };
  const r3 = await postJson('/api/tweets', payload2);
  assert(r3.ok === true, '仅 URL 的旧流程保存成功');

  let rec2;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    rec2 = store.get(T2);
    if (rec2 && rec2.media[0] && rec2.media[0].path) break;
  }
  assert(rec2 && rec2.media[0] && rec2.media[0].path === `media/images/${T2}-1.jpg`, '兜底下载完成并记录路径');
  assert(fs.existsSync(path.join(dataDir, 'media', 'images', `${T2}-1.jpg`)), '兜底下载的图片文件存在');

  // ---------- keyset 分页 ----------
  // 同一用户新增数条带发帖时间的推文（发帖时间乱序给出，验证用户视图按发帖时间倒序、无时间的排最后）
  const U = 'pager_user';
  const pagerIds = [];
  const pagerTimes = ['2026-05-03T00:00:00.000Z', '2026-09-10T00:00:00.000Z', null, '2026-07-01T00:00:00.000Z'];
  for (let i = 0; i < pagerTimes.length; i++) {
    const id = '300000000000000000' + i; // 注意不能用数字相加（超出 2^53 精度会重合）
    pagerIds.push(id);
    const r = await postJson('/api/tweets', {
      id,
      url: `https://x.com/${U}/status/${id}`,
      userName: '分页用户',
      userId: U,
      content: 'pager tweet ' + i,
      tweetTime: pagerTimes[i],
      media: [],
    });
    assert(r.ok === true, `分页用推文 ${i} 保存成功`);
    await new Promise((res) => setTimeout(res, 5)); // 拉开 savedAt
  }

  // 时间线：全部推文按保存时间倒序，翻页无重复无遗漏
  const allIds = [];
  const allKeys = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const p = store.page({ view: 'timeline', cursor, limit: 2 });
    pages++;
    allIds.push(...p.items.map((t) => t.id));
    allKeys.push(...p.items.map((t) => t._keys.timeline));
    if (p.items.length) {
      assert(p.items.every((t) => t._keys && t._keys.timeline && t._keys.user), '分页结果附带排序键 _keys');
    }
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  assert(
    allKeys.every((k, i) => i === 0 || allKeys[i - 1] > k),
    '翻页按排序键严格递减（keyset 单调）'
  );
  const expectedTotal = 1 + 1 + 1 + pagerIds.length; // 迁移 1 + T1 + T2 + pager 4
  assert(store.count({ view: 'timeline' }) === expectedTotal, `时间线总数正确（${expectedTotal}）`);
  assert(allIds.length === expectedTotal && new Set(allIds).size === allIds.length, '翻页遍历无重复无遗漏');
  assert(pages >= Math.ceil(expectedTotal / 2), '分页按 limit 生效');

  // 用户视图：按发帖时间倒序，无发帖时间的排最后
  const up1 = store.page({ view: 'user', userId: U, limit: 2 });
  assert(up1.total === pagerIds.length && up1.items.length === 2, '用户视图分页返回正确');
  const order = [];
  {
    let c = null;
    for (;;) {
      const p = store.page({ view: 'user', userId: U, cursor: c, limit: 3 });
      order.push(...p.items.map((t) => t.content));
      if (!p.nextCursor) break;
      c = p.nextCursor;
    }
  }
  assert(
    JSON.stringify(order) === JSON.stringify(['pager tweet 1', 'pager tweet 3', 'pager tweet 0', 'pager tweet 2']),
    '用户视图按发帖时间倒序、无发帖时间的排最后'
  );
  assert(store.count({ view: 'user', userId: 'nobody' }) === 0, '不存在用户的计数为 0');

  // ---------- 增量变更事件 ----------
  const upserts = changes.filter((c) => c.event === 'upsert');
  assert(upserts.length >= expectedTotal, '每次保存都发出 upsert 事件');
  assert(upserts.every((c) => c.data && c.data._keys), 'upsert 事件携带排序键');
  assert(changes.some((c) => c.event === 'upsert' && c.data && c.data.id === T1 && c.data.avatar), '兜底下载完成也发出 upsert 更新');

  // ---------- 删除（含媒体文件清理） ----------
  await store.deleteTweet(T1);
  assert(store.get(T1) === null, '删除后数据库记录消失');
  assert(!fs.existsSync(path.join(dataDir, 'media', 'videos', `${T1}-2.mp4`)), '删除推文时视频文件一并删除');
  assert(changes.some((c) => c.event === 'delete' && c.data === T1), '删除发出 delete 事件');
  assert(store.count({ view: 'timeline' }) === expectedTotal - 1, '删除后总数减少');

  // 空内容推文应被拒绝
  const r4 = await postJson('/api/tweets', { id: '1112223334445556667', content: '', media: [] });
  assert(r4.ok === false, '空推文被拒绝');

  // 清理
  api.close();
  origin.close();
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  const code = process.exitCode ? 1 : 0;
  tee(code ? '\n存在失败的断言！' : '\n全部测试通过 ✓');
  console.log(code ? '\n存在失败的断言！' : '\n全部测试通过 ✓');
  try {
    fs.writeFileSync(DONE_FILE, JSON.stringify({ code, at: Date.now() }), 'utf8');
  } catch (e) {
    /* ignore */
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  tee('ERROR: ' + ((e && e.stack) || e));
  try {
    fs.writeFileSync(DONE_FILE, JSON.stringify({ code: 1, at: Date.now() }), 'utf8');
  } catch (e2) {
    /* ignore */
  }
  process.exit(1);
});

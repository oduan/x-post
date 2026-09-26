'use strict';

/**
 * 离线集成测试（不依赖 Electron / 网络）：
 *   1. 启动本地 HTTP 服务模拟图片/视频源（用于应用端兜底下载路径）
 *   2. 模拟扩展新流程：先 POST /api/media 上传二进制，再 POST /api/tweets 提交元信息
 *   3. 验证暂存文件移入正式目录、时间线记录立即带本地路径、重复保存去重、旧版扩展（仅 URL）兜底
 * 用法：node tools/test-store.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createTweetStore } = require('../electron-app/lib/store');
const { startServer } = require('../electron-app/lib/server');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    console.log('PASS: ' + msg);
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
  let changeCount = 0;
  const store = createTweetStore(dataDir, () => changeCount++);

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

  // 元信息落盘时媒体路径应立即就位（来自暂存），不等兜底下载
  const rec1 = (await store.list()).find((t) => t.id === T1);
  assert(!!rec1, '能列出已保存推文');
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
    const t = (await store.list()).find((x) => x.id === T1);
    avatarOk = !!(t && t.avatar);
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
    rec2 = (await store.list()).find((t) => t.id === T2);
    if (rec2 && rec2.media[0] && rec2.media[0].path) break;
  }
  assert(rec2 && rec2.media[0] && rec2.media[0].path === `media/images/${T2}-1.jpg`, '兜底下载完成并记录路径');
  assert(fs.existsSync(path.join(dataDir, 'media', 'images', `${T2}-1.jpg`)), '兜底下载的图片文件存在');

  // ---------- 删除（含媒体文件清理） ----------
  await store.deleteTweet(T1);
  assert(!fs.existsSync(path.join(dataDir, 'media', 'videos', `${T1}-2.mp4`)), '删除推文时视频文件一并删除');
  assert(!fs.existsSync(path.join(dataDir, 'tweets', `${T1}.json`)), '删除推文时 JSON 一并删除');

  // 空内容推文应被拒绝
  const r4 = await postJson('/api/tweets', { id: '1112223334445556667', content: '', media: [] });
  assert(r4.ok === false, '空推文被拒绝');

  assert(changeCount >= 2, '数据变化回调（onChange）已被触发');

  // 清理
  api.close();
  origin.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(process.exitCode ? '\n存在失败的断言！' : '\n全部测试通过 ✓');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

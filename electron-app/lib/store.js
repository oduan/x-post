'use strict';

// 纯文本数据存储：
//   <dataDir>/tweets/*.json          每条推文一个 JSON 元信息文件（含媒体相对路径）
//   <dataDir>/media/images/          图片（原始二进制）
//   <dataDir>/media/videos/          视频（.mp4）
//   <dataDir>/media/avatars/         用户头像
//   <dataDir>/.staging/              扩展预上传媒体的暂存区（提交元信息时移入正式目录）
// 不使用任何数据库。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.m4v']);
const UPLOAD_CAP = 2 * 1024 * 1024 * 1024; // 单个媒体上传上限 2GB

function str(v) {
  return typeof v === 'string' ? v : '';
}

function sanitizeName(s) {
  return String(s).replace(/[^\w.-]/g, '_');
}

function extFor(u, fallback) {
  try {
    const parsed = new URL(u);
    const fmt = (parsed.searchParams.get('format') || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(fmt)) return fmt === 'jpeg' ? '.jpg' : '.' + fmt;
    const m = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname);
    if (m) {
      const e = '.' + m[1].toLowerCase();
      if (ALLOWED_EXTS.has(e)) return e === '.jpeg' ? '.jpg' : e;
    }
  } catch (e) {
    /* ignore */
  }
  return fallback;
}

function extFromMime(ct) {
  ct = String(ct || '').toLowerCase();
  if (ct.indexOf('mp4') !== -1) return '.mp4';
  if (ct.indexOf('png') !== -1) return '.png';
  if (ct.indexOf('webp') !== -1) return '.webp';
  if (ct.indexOf('gif') !== -1) return '.gif';
  if (ct.indexOf('jpeg') !== -1 || ct.indexOf('jpg') !== -1) return '.jpg';
  return '';
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (e) {
    return false;
  }
}

async function writeJson(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function downloadTo(url, dest, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        Referer: 'https://x.com/',
        Accept: '*/*',
      },
    });
    if (!res.ok || !res.body) return false;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    const stat = await fsp.stat(dest).catch(() => null);
    if (!stat || stat.size === 0) {
      await fsp.rm(dest, { force: true });
      return false;
    }
    return true;
  } catch (e) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} dataDir 数据根目录
 * @param {() => void} [onChange] 数据发生变化（可用于通知界面刷新）
 */
function createTweetStore(dataDir, onChange) {
  const dirs = {
    tweets: path.join(dataDir, 'tweets'),
    images: path.join(dataDir, 'media', 'images'),
    videos: path.join(dataDir, 'media', 'videos'),
    avatars: path.join(dataDir, 'media', 'avatars'),
    staging: path.join(dataDir, '.staging'),
  };

  async function ensureDirs() {
    await fsp.mkdir(dataDir, { recursive: true });
    for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  }

  // 所有兜底下载串行排队，避免并发请求过多
  let chain = Promise.resolve();
  function enqueue(task) {
    const next = chain.then(task).catch((e) => console.error('[x-post] 后台下载任务失败:', e));
    chain = next;
    return next;
  }

  /** 该推文是否已存在 */
  async function existsTweet(id) {
    id = str(id).trim();
    if (!/^\d{5,25}$/.test(id)) return false;
    return exists(path.join(dirs.tweets, id + '.json'));
  }

  /**
   * 接收扩展上传的媒体二进制，写入暂存区 .staging/<tweetId>-<index>[-poster].<ext>
   * （写入 .tmp 再改名，避免半截文件被当成完整上传）
   */
  async function uploadMedia({ id, index, role, ext, contentType, stream }) {
    id = str(id).trim();
    if (!/^\d{5,25}$/.test(id)) throw new Error('无效的推文 ID');
    if (!(Number.isInteger(index) && index >= 0 && index <= 19)) throw new Error('无效的媒体序号');
    const suffix = role === 'poster' ? '-poster' : '';
    let finalExt = extFromMime(contentType);
    if (!finalExt && /^\.[a-z0-9]{2,5}$/i.test(str(ext))) finalExt = str(ext).toLowerCase();
    if (!ALLOWED_EXTS.has(finalExt)) finalExt = String(contentType).indexOf('video') !== -1 ? '.mp4' : '.jpg';

    await ensureDirs();
    const tmp = path.join(dirs.staging, `${id}-${index}${suffix}${finalExt}.tmp`);
    const fin = path.join(dirs.staging, `${id}-${index}${suffix}${finalExt}`);

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      let size = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        try { stream.destroy(); ws.destroy(); } catch (e) { /* ignore */ }
        fsp.rm(tmp, { force: true }).catch(() => {});
        reject(err);
      };
      stream.on('data', (c) => {
        size += c.length;
        if (size > UPLOAD_CAP) fail(new Error('媒体文件过大'));
      });
      stream.on('aborted', () => fail(new Error('上传中断')));
      stream.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', () => { if (!failed) resolve(); });
      stream.on('end', () => { if (!failed) ws.end(); });
      stream.pipe(ws);
    });

    const stat = await fsp.stat(tmp).catch(() => null);
    if (!stat || stat.size === 0) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error('媒体内容为空');
    }
    await fsp.rename(tmp, fin);
    return { ok: true };
  }

  /** 从暂存区取走 <id>-<index><suffix>.<ext> 并移入正式目录；没有则返回 null */
  async function takeStaged(id, index, suffix, destKind) {
    let files = [];
    try {
      files = await fsp.readdir(dirs.staging);
    } catch (e) {
      return null;
    }
    const prefix = `${id}-${index}${suffix}.`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const ext = '.' + f.slice(prefix.length).toLowerCase();
      if (ext === '.tmp' || !ALLOWED_EXTS.has(ext)) continue;
      const folder = destKind === 'video' ? 'videos' : 'images';
      const name = `${id}-${index}${suffix}${ext}`;
      try {
        await fsp.rename(path.join(dirs.staging, f), path.join(dirs[destKind === 'video' ? 'videos' : 'images'], name));
        return { rel: `media/${folder}/${name}` };
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /** 清掉该推文残留的暂存文件 */
  async function cleanStaging(id) {
    try {
      for (const f of await fsp.readdir(dirs.staging)) {
        if (f.startsWith(id + '-')) await fsp.rm(path.join(dirs.staging, f), { force: true });
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 保存一条推文。媒体优先使用扩展预上传的暂存文件（随元信息一并落盘）；
   * 缺失的媒体项（扩展下载失败等）由服务端按 URL 兜底下载并在完成后更新。
   */
  async function saveTweet(payload) {
    await ensureDirs();
    const id = str(payload && payload.id).trim();
    if (!/^\d{5,25}$/.test(id)) throw new Error('无效的推文 ID');

    const jsonPath = path.join(dirs.tweets, id + '.json');
    if (await exists(jsonPath)) {
      await cleanStaging(id);
      return { duplicate: true };
    }

    const record = {
      id,
      url: str(payload.url),
      userName: str(payload.userName),
      userId: str(payload.userId),
      avatar: null,
      title: str(payload.title),
      content: str(payload.content),
      tweetTime: str(payload.tweetTime) || null,
      savedAt: new Date().toISOString(),
      quotedTweet:
        payload.quoted && (str(payload.quoted.userName) || str(payload.quoted.content))
          ? {
              userName: str(payload.quoted.userName),
              userId: str(payload.quoted.userId),
              content: str(payload.quoted.content),
              url: str(payload.quoted.url),
            }
          : null,
      media: [],
    };
    if (!record.content && !record.quotedTweet && !(payload.media && payload.media.length)) {
      await cleanStaging(id);
      throw new Error('推文内容为空');
    }

    const fallbacks = [];
    let idx = 0;
    for (const m of payload.media || []) {
      idx++;
      if (m && m.kind === 'image' && m.url) {
        const entry = { kind: 'image', url: m.url, path: null, width: m.width || 0, height: m.height || 0 };
        const staged = await takeStaged(id, idx, '', 'image');
        if (staged) entry.path = staged.rel;
        else fallbacks.push({ entry, url: m.url, index: idx, role: 'main' });
        record.media.push(entry);
      } else if (m && m.kind === 'video') {
        const entry = {
          kind: 'video',
          url: m.url || null,
          path: null,
          poster: m.poster || null,
          posterPath: null,
          duration: m.duration || 0,
          width: m.width || 0,
          height: m.height || 0,
        };
        const main = await takeStaged(id, idx, '', 'video');
        if (main) entry.path = main.rel;
        else if (m.url) fallbacks.push({ entry, url: m.url, index: idx, role: 'main' });
        const poster = await takeStaged(id, idx, '-poster', 'image');
        if (poster) entry.posterPath = poster.rel;
        else if (m.poster) fallbacks.push({ entry, url: m.poster, index: idx, role: 'poster' });
        record.media.push(entry);
      }
    }

    await writeJson(jsonPath, record);
    if (onChange) onChange();
    await cleanStaging(id);

    if (payload.avatarUrl || fallbacks.length) {
      enqueue(() => finishFallbacks(jsonPath, record, payload, fallbacks));
    }
    return { duplicate: false };
  }

  async function finishFallbacks(jsonPath, record, payload, fallbacks) {
    let dirty = false;

    if (payload.avatarUrl) {
      const name = sanitizeName(record.userId || 'unknown') + extFor(payload.avatarUrl, '.jpg');
      const rel = 'media/avatars/' + name;
      if (await downloadTo(payload.avatarUrl, path.join(dataDir, rel))) {
        record.avatar = rel;
        dirty = true;
      }
    }

    for (const fb of fallbacks) {
      if (fb.role === 'poster') {
        const rel = `media/images/${record.id}-${fb.index}-poster` + extFor(fb.url, '.jpg');
        if (await downloadTo(fb.url, path.join(dataDir, rel))) {
          fb.entry.posterPath = rel;
          dirty = true;
        }
      } else {
        const isVideo = fb.entry.kind === 'video';
        const folder = isVideo ? 'videos' : 'images';
        const rel = `media/${folder}/${record.id}-${fb.index}` + (isVideo ? '.mp4' : extFor(fb.url, '.jpg'));
        if (await downloadTo(fb.url, path.join(dataDir, rel), 300000)) {
          fb.entry.path = rel;
          dirty = true;
        }
      }
    }

    if (dirty) {
      await writeJson(jsonPath, record);
      if (onChange) onChange();
    }
  }

  /**
   * 删除一条推文：删除其 JSON 元信息文件，并一并删除该推文专属的
   * 图片/视频/封面文件（头像按 handle 命名、可能被其他推文共用，保留）。
   */
  async function deleteTweet(id) {
    id = str(id).trim();
    if (!/^\d{5,25}$/.test(id)) throw new Error('无效的推文 ID');
    const safeRel = (rel) => typeof rel === 'string' && rel.startsWith('media/') && rel.indexOf('..') === -1;

    const jsonPath = path.join(dirs.tweets, id + '.json');
    let record = null;
    try {
      record = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    } catch (e) {
      /* 元信息文件不存在时按已删除处理 */
    }
    await fsp.rm(jsonPath, { force: true });
    await cleanStaging(id);

    if (record && Array.isArray(record.media)) {
      for (const m of record.media) {
        for (const rel of [m.path, m.posterPath]) {
          if (safeRel(rel)) {
            await fsp.rm(path.join(dataDir, rel), { force: true }).catch(() => {});
          }
        }
      }
    }
    if (onChange) onChange();
    return { deleted: true };
  }

  /** 列出全部推文，按保存时间倒序（新的在前） */
  async function list() {
    await ensureDirs();
    const files = await fsp.readdir(dirs.tweets).catch(() => []);
    const tweets = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(await fsp.readFile(path.join(dirs.tweets, f), 'utf8'));
        if (t && t.id) tweets.push(t);
      } catch (e) {
        /* 跳过损坏的文件 */
      }
    }
    tweets.sort(
      (a, b) =>
        String(b.savedAt || '').localeCompare(String(a.savedAt || '')) || String(b.id).localeCompare(String(a.id))
    );
    return tweets;
  }

  return { dataDir, ensureDirs, saveTweet, deleteTweet, list, uploadMedia, existsTweet };
}

module.exports = { createTweetStore };

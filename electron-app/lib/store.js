'use strict';

// SQLite 单文件数据库存储：
//   <dataDir>/xpost.db              推文元信息数据库（SQLite，WAL 模式）
//   <dataDir>/media/images/         图片（原始二进制）
//   <dataDir>/media/videos/         视频（.mp4）
//   <dataDir>/media/avatars/        用户头像
//   <dataDir>/.staging/             扩展预上传媒体的暂存区（提交元信息时移入正式目录）
//   <dataDir>/tweets.bak-<时间>/    旧版逐条 JSON 存档（首次启动自动导入数据库后改名保留）
// 媒体文件仍为磁盘原始文件，只有元信息进库。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DB_FILE = 'xpost.db';
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

function tweetTimeMsOf(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// 时间线排序键：保存时间倒序，id 作并列时的稳定次序
function tlKeyOf(savedAt, id) {
  return String(savedAt || '') + '|' + String(id || '');
}

// 用户视图排序键：有发帖时间的在前（时间倒序）、无发帖时间的排最后。
// 排序为 DESC（大键在前），因此「有发帖时间」的标志位取 '1'（排在无时间的 '0' 之前）；
// 时间戳 +1e16 定长化为 17 位数字串，保证字符串比较与数值比较一致。
function userKeyOf(tweetTimeMs, savedAt, id) {
  const has = Number.isFinite(tweetTimeMs);
  const digits = String(has ? Math.floor(tweetTimeMs) + 1e16 : 0).padStart(17, '0');
  return (has ? '1' : '0') + digits + '|' + String(savedAt || '') + '|' + String(id || '');
}

/**
 * 创建推文库。首次启动时若发现旧版 tweets/*.json 逐条存档，会自动导入数据库
 * 并把旧目录改名为 tweets.bak-<时间> 保留（不删除任何数据）。
 *
 * 数据变化通过 onChange(event, data) 通知：
 *   ('upsert', record) 新增或更新了一条推文（record 含排序键 _keys）
 *   ('delete', id)     删除了一条推文
 * @param {string} dataDir 数据根目录
 * @param {(event: 'upsert'|'delete', data: object|string) => void} [onChange]
 */
async function createTweetStore(dataDir, onChange) {
  const dirs = {
    images: path.join(dataDir, 'media', 'images'),
    videos: path.join(dataDir, 'media', 'videos'),
    avatars: path.join(dataDir, 'media', 'avatars'),
    staging: path.join(dataDir, '.staging'),
  };
  const dbPath = path.join(dataDir, DB_FILE);

  async function ensureDirs() {
    await fsp.mkdir(dataDir, { recursive: true });
    for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  }

  await ensureDirs();

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS tweets (
      id            TEXT PRIMARY KEY,
      url           TEXT NOT NULL DEFAULT '',
      user_id       TEXT NOT NULL DEFAULT '',
      user_name     TEXT NOT NULL DEFAULT '',
      avatar        TEXT,
      title         TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL DEFAULT '',
      tweet_time    TEXT,
      tweet_time_ms INTEGER,
      saved_at      TEXT NOT NULL,
      quoted        TEXT,
      media         TEXT NOT NULL DEFAULT '[]',
      tl_key        TEXT NOT NULL,
      user_key      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tweets_tl ON tweets (tl_key DESC);
    CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets (user_id, user_key DESC);
  `);

  const stmts = {
    get: db.prepare('SELECT * FROM tweets WHERE id = ?'),
    insert: db.prepare(
      `INSERT OR IGNORE INTO tweets
        (id, url, user_id, user_name, avatar, title, content, tweet_time, tweet_time_ms, saved_at, quoted, media, tl_key, user_key)
       VALUES
        (@id, @url, @user_id, @user_name, @avatar, @title, @content, @tweet_time, @tweet_time_ms, @saved_at, @quoted, @media, @tl_key, @user_key)`
    ),
    update: db.prepare(
      `UPDATE tweets SET url=@url, user_id=@user_id, user_name=@user_name, avatar=@avatar, title=@title,
        content=@content, tweet_time=@tweet_time, tweet_time_ms=@tweet_time_ms, saved_at=@saved_at,
        quoted=@quoted, media=@media, tl_key=@tl_key, user_key=@user_key
       WHERE id=@id`
    ),
    remove: db.prepare('DELETE FROM tweets WHERE id = ?'),
    countAll: db.prepare('SELECT COUNT(*) AS c FROM tweets'),
    countUser: db.prepare('SELECT COUNT(*) AS c FROM tweets WHERE user_id = ?'),
    tlFirst: db.prepare('SELECT * FROM tweets ORDER BY tl_key DESC LIMIT ?'),
    tlAfter: db.prepare('SELECT * FROM tweets WHERE tl_key < ? ORDER BY tl_key DESC LIMIT ?'),
    userFirst: db.prepare('SELECT * FROM tweets WHERE user_id = ? ORDER BY user_key DESC LIMIT ?'),
    userAfter: db.prepare('SELECT * FROM tweets WHERE user_id = ? AND user_key < ? ORDER BY user_key DESC LIMIT ?'),
  };

  function recordToRow(t) {
    const savedAt = t.savedAt || new Date().toISOString();
    const ms = tweetTimeMsOf(t.tweetTime);
    return {
      id: String(t.id),
      url: str(t.url),
      user_id: str(t.userId),
      user_name: str(t.userName),
      avatar: t.avatar ? str(t.avatar) : null,
      title: str(t.title),
      content: str(t.content),
      tweet_time: t.tweetTime ? str(t.tweetTime) : null,
      tweet_time_ms: ms,
      saved_at: savedAt,
      quoted: t.quotedTweet ? JSON.stringify(t.quotedTweet) : null,
      media: JSON.stringify(Array.isArray(t.media) ? t.media : []),
      tl_key: tlKeyOf(savedAt, t.id),
      user_key: userKeyOf(ms, savedAt, t.id),
    };
  }

  function rowToItem(r) {
    return {
      id: r.id,
      url: r.url,
      userName: r.user_name,
      userId: r.user_id,
      avatar: r.avatar,
      title: r.title,
      content: r.content,
      tweetTime: r.tweet_time,
      savedAt: r.saved_at,
      quotedTweet: r.quoted ? JSON.parse(r.quoted) : null,
      media: JSON.parse(r.media),
      // 渲染端做增量插入/删除时用于排序定位
      _keys: { timeline: r.tl_key, user: r.user_key },
    };
  }

  function keysOfRecord(t) {
    const savedAt = t.savedAt || '';
    const ms = tweetTimeMsOf(t.tweetTime);
    return { timeline: tlKeyOf(savedAt, t.id), user: userKeyOf(ms, savedAt, t.id) };
  }

  function getRecord(id) {
    const r = stmts.get.get(id);
    return r ? rowToItem(r) : null;
  }

  function notify(event, data) {
    if (onChange) onChange(event, data);
  }

  // ---------- 旧版 JSON 存档迁移 ----------

  async function migrateFromJsonArchives() {
    const done = db.prepare("SELECT value FROM meta WHERE key = 'json_migrated'").get();
    if (done) return;
    const tweetsDir = path.join(dataDir, 'tweets');
    let files = [];
    try {
      files = (await fsp.readdir(tweetsDir)).filter((f) => f.endsWith('.json'));
    } catch (e) {
      files = [];
    }
    if (files.length) {
      const rows = [];
      for (const f of files) {
        try {
          const t = JSON.parse(await fsp.readFile(path.join(tweetsDir, f), 'utf8'));
          if (t && /^\d{5,25}$/.test(String(t.id))) rows.push(recordToRow(t));
        } catch (e) {
          /* 跳过损坏的存档文件 */
        }
      }
      const importAll = db.transaction((list) => {
        for (const row of list) stmts.insert.run(row);
      });
      importAll(rows);
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')").run();
    if (files.length) {
      // 导入完成后把旧目录改名保留，避免出现两份存储源；失败仅记录（下轮已不再读取）
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try {
        await fsp.rename(tweetsDir, path.join(dataDir, 'tweets.bak-' + stamp));
        console.log(`[x-post] 已将 ${files.length} 条旧版 JSON 存档导入数据库，原目录保留为 tweets.bak-${stamp}`);
      } catch (e) {
        console.error('[x-post] 旧版存档目录改名失败（数据已导入数据库）:', e);
      }
    }
  }

  await migrateFromJsonArchives();

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
    return !!stmts.get.get(id);
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
   * 保存一条推文。媒体优先使用扩展预上传的暂存文件（随元信息一并入库）；
   * 缺失的媒体项（扩展下载失败等）由服务端按 URL 兜底下载并在完成后更新。
   */
  async function saveTweet(payload) {
    await ensureDirs();
    const id = str(payload && payload.id).trim();
    if (!/^\d{5,25}$/.test(id)) throw new Error('无效的推文 ID');

    if (stmts.get.get(id)) {
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

    stmts.insert.run(recordToRow(record));
    if (onChange) onChange('upsert', { ...record, _keys: keysOfRecord(record) });
    await cleanStaging(id);

    if (payload.avatarUrl || fallbacks.length) {
      enqueue(() => finishFallbacks(id, payload, fallbacks));
    }
    return { duplicate: false };
  }

  async function finishFallbacks(id, payload, fallbacks) {
    const record = getRecord(id);
    if (!record) return;
    let dirty = false;

    if (payload.avatarUrl && !record.avatar) {
      const name = sanitizeName(record.userId || 'unknown') + extFor(payload.avatarUrl, '.jpg');
      const rel = 'media/avatars/' + name;
      if (await downloadTo(payload.avatarUrl, path.join(dataDir, rel))) {
        record.avatar = rel;
        dirty = true;
      }
    }

    for (const fb of fallbacks) {
      // 记录是从数据库重读的新对象，不能按引用比对；按角色 + URL 定位对应的媒体项
      const entry = record.media.find((m) =>
        fb.role === 'poster'
          ? m && m.kind === 'video' && !m.posterPath && m.poster === fb.url
          : m && !m.path && m.url === fb.url
      );
      if (!entry) continue;
      if (fb.role === 'poster') {
        if (entry.posterPath) continue;
        const rel = `media/images/${record.id}-${fb.index}-poster` + extFor(fb.url, '.jpg');
        if (await downloadTo(fb.url, path.join(dataDir, rel))) {
          entry.posterPath = rel;
          dirty = true;
        }
      } else {
        if (entry.path) continue;
        const isVideo = entry.kind === 'video';
        const folder = isVideo ? 'videos' : 'images';
        const rel = `media/${folder}/${record.id}-${fb.index}` + (isVideo ? '.mp4' : extFor(fb.url, '.jpg'));
        if (await downloadTo(fb.url, path.join(dataDir, rel), 300000)) {
          entry.path = rel;
          dirty = true;
        }
      }
    }

    if (dirty) {
      const row = recordToRow(record);
      stmts.update.run(row);
      notify('upsert', { ...record, _keys: record._keys || keysOfRecord(record) });
    }
  }

  /**
   * 删除一条推文：删除其数据库记录，并一并删除该推文专属的
   * 图片/视频/封面文件（头像按 handle 命名、可能被其他推文共用，保留）。
   */
  async function deleteTweet(id) {
    id = str(id).trim();
    if (!/^\d{5,25}$/.test(id)) throw new Error('无效的推文 ID');
    const safeRel = (rel) => typeof rel === 'string' && rel.startsWith('media/') && rel.indexOf('..') === -1;

    const record = getRecord(id);
    stmts.remove.run(id);
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
    notify('delete', id);
    return { deleted: true };
  }

  /**
   * 分页读取（keyset 游标，避免新推文插入导致 OFFSET 翻页错位）。
   * @param {{view?: 'timeline'|'user', userId?: string, cursor?: string|null, limit?: number}} opts
   *   游标为上一页最后一条的排序键（nextCursor 原样回传即可）
   * @returns {{items: object[], nextCursor: string|null, total: number}}
   */
  function page(opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(200, Number.isInteger(o.limit) ? o.limit : 50));
    const cursor = typeof o.cursor === 'string' && o.cursor ? o.cursor : null;

    let rows;
    let total;
    let keyCol;
    if (o.view === 'user') {
      const userId = str(o.userId);
      total = stmts.countUser.get(userId).c;
      rows = cursor ? stmts.userAfter.all(userId, cursor, limit) : stmts.userFirst.all(userId, limit);
      keyCol = 'user_key';
    } else {
      total = stmts.countAll.get().c;
      rows = cursor ? stmts.tlAfter.all(cursor, limit) : stmts.tlFirst.all(limit);
      keyCol = 'tl_key';
    }
    const items = rows.map(rowToItem);
    // 刚好取满一页时才可能有下一页；不足一页说明已到末尾
    const nextCursor = rows.length === limit ? rows[rows.length - 1][keyCol] : null;
    return { items, nextCursor, total };
  }

  /** 当前视图的推文总数（用于刷新顶栏计数，不必拉数据） */
  function count(opts) {
    const o = opts || {};
    if (o.view === 'user') return stmts.countUser.get(str(o.userId)).c;
    return stmts.countAll.get().c;
  }

  return {
    dataDir,
    dbPath,
    ensureDirs,
    close: () => {
      try {
        db.close();
      } catch (e) {
        /* ignore */
      }
    },
    saveTweet,
    deleteTweet,
    page,
    count,
    get: getRecord,
    uploadMedia,
    existsTweet,
  };
}

module.exports = { createTweetStore };

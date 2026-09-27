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

// 平台与作品 ID：记录主键为组合 ID「platform:rawId」（如 x:123…、douyin:7345…），
// 不同平台的作品/作者天然隔离，后续新平台只需扩展端多一个抽取器
const RE_PLATFORM = /^[a-z][a-z0-9]{0,31}$/;
const RE_RAW_ID = /^[A-Za-z0-9._-]{1,128}$/;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// 校验并拆分组合 ID，非法返回 null
function parseRid(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const platform = s.slice(0, i);
  const rawId = s.slice(i + 1);
  if (!RE_PLATFORM.test(platform) || !RE_RAW_ID.test(rawId)) return null;
  return { platform, rawId };
}

// 组合 ID 直接出现在媒体文件名里，':' 在 Windows 上非法，统一替换为 '_'
// （平台名不含 '_'，替换后不会与其它组合 ID 撞名）
function fileSafeId(rid) {
  return String(rid).replace(/[^A-Za-z0-9._-]/g, '_');
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

// 抖音的媒体/头像 CDN 校验 Referer，缺失会 403；X 的图床则不需要。
// 兜底下载是 Node 发起的，可以自由设置该头（扩展的 Service Worker 不允许）。
function refererFor(u) {
  try {
    if (/douyin(pic|vod|static)?\.com$/.test(new URL(u).hostname)) return 'https://www.douyin.com/';
  } catch (e) {
    /* ignore */
  }
  return undefined;
}

async function downloadTo(url, dest, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      Accept: '*/*',
    };
    const referer = refererFor(url);
    if (referer) headers.Referer = referer;
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers,
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
      platform      TEXT NOT NULL DEFAULT 'x',
      author_key    TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS authors (
      platform   TEXT NOT NULL,
      author_key TEXT NOT NULL,
      user_id    TEXT NOT NULL DEFAULT '',
      user_name  TEXT NOT NULL DEFAULT '',
      avatar     TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform, author_key)
    );
    CREATE TABLE IF NOT EXISTS author_names (
      platform   TEXT NOT NULL,
      author_key TEXT NOT NULL,
      user_name  TEXT NOT NULL,
      from_at    TEXT NOT NULL,
      to_at      TEXT,
      PRIMARY KEY (platform, author_key, user_name, from_at)
    );
    CREATE INDEX IF NOT EXISTS idx_tweets_tl ON tweets (tl_key DESC);
  `);

  // 旧库升级：① 补 platform / author_key 列；② 旧记录的纯数字主键改写为组合 ID「x:<id>」并重算排序键
  // （幂等：新记录主键都含「:」，legacy 查询不再命中）
  const cols = db.prepare('PRAGMA table_info(tweets)').all().map((c) => c.name);
  if (!cols.includes('platform')) {
    db.exec("ALTER TABLE tweets ADD COLUMN platform TEXT NOT NULL DEFAULT 'x'");
  }
  if (!cols.includes('author_key')) {
    db.exec("ALTER TABLE tweets ADD COLUMN author_key TEXT NOT NULL DEFAULT ''");
  }
  // 作者键回填：旧记录没有稳定键，用当时存的展示 ID（X=handle，抖音多为 sec_uid）
  db.exec("UPDATE tweets SET author_key = user_id WHERE author_key = ''");
  const legacyRows = db.prepare("SELECT id, saved_at, tweet_time_ms FROM tweets WHERE instr(id, ':') = 0").all();
  if (legacyRows.length) {
    const upd = db.prepare('UPDATE tweets SET id = ?, tl_key = ?, user_key = ? WHERE id = ?');
    db.transaction(() => {
      for (const r of legacyRows) {
        const rid = 'x:' + r.id;
        upd.run(rid, tlKeyOf(r.saved_at, rid), userKeyOf(r.tweet_time_ms, r.saved_at, rid), r.id);
      }
    })();
  }
  // 首次升级到作者表：从既有推文回填（名字/头像取每位作者最新一条的快照），并写入首条名字历史
  if (db.prepare('SELECT COUNT(*) AS c FROM authors').get().c === 0) {
    db.exec(`
      INSERT OR IGNORE INTO authors (platform, author_key, user_id, user_name, avatar, updated_at)
      SELECT t.platform, t.author_key, t.user_id, t.user_name, t.avatar, t.saved_at
      FROM tweets t
      JOIN (
        SELECT platform, author_key, MAX(saved_at) AS m
        FROM tweets WHERE author_key != '' GROUP BY platform, author_key
      ) g ON g.platform = t.platform AND g.author_key = t.author_key AND g.m = t.saved_at;
      INSERT OR IGNORE INTO author_names (platform, author_key, user_name, from_at, to_at)
      SELECT platform, author_key, user_name, updated_at, NULL FROM authors;
    `);
  }
  // 用户视图索引从 (user_id) 升级为 (platform, author_key)：定义不匹配时重建（避免每次启动都重建索引）
  const userIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tweets_user'").get();
  if (!userIdx || !/author_key/.test(userIdx.sql || '')) {
    db.exec('DROP INDEX IF EXISTS idx_tweets_user');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets (platform, author_key, user_key DESC)');
  }

  // 读取一律联作者表：卡片展示的是作者的当前名字/展示 ID（历史在 author_names 里保留），
  // 推文行内的 user_name/user_id 只是保存当时的快照
  const SQL_T =
    'SELECT t.*, a.user_name AS a_name, a.user_id AS a_uid, a.avatar AS a_avatar ' +
    'FROM tweets t LEFT JOIN authors a ON a.platform = t.platform AND a.author_key = t.author_key';

  const stmts = {
    get: db.prepare(`${SQL_T} WHERE t.id = ?`),
    insert: db.prepare(
      `INSERT OR IGNORE INTO tweets
        (id, platform, author_key, url, user_id, user_name, avatar, title, content, tweet_time, tweet_time_ms, saved_at, quoted, media, tl_key, user_key)
       VALUES
        (@id, @platform, @author_key, @url, @user_id, @user_name, @avatar, @title, @content, @tweet_time, @tweet_time_ms, @saved_at, @quoted, @media, @tl_key, @user_key)`
    ),
    update: db.prepare(
      `UPDATE tweets SET url=@url, author_key=@author_key, user_id=@user_id, user_name=@user_name, avatar=@avatar, title=@title,
        content=@content, tweet_time=@tweet_time, tweet_time_ms=@tweet_time_ms, saved_at=@saved_at,
        quoted=@quoted, media=@media, tl_key=@tl_key, user_key=@user_key
       WHERE id=@id`
    ),
    remove: db.prepare('DELETE FROM tweets WHERE id = ?'),
    countAll: db.prepare('SELECT COUNT(*) AS c FROM tweets'),
    countUser: db.prepare('SELECT COUNT(*) AS c FROM tweets WHERE platform = ? AND author_key = ?'),
    tlFirst: db.prepare(`${SQL_T} ORDER BY t.tl_key DESC LIMIT ?`),
    tlAfter: db.prepare(`${SQL_T} WHERE t.tl_key < ? ORDER BY t.tl_key DESC LIMIT ?`),
    userFirst: db.prepare(`${SQL_T} WHERE t.platform = ? AND t.author_key = ? ORDER BY t.user_key DESC LIMIT ?`),
    userAfter: db.prepare(
      `${SQL_T} WHERE t.platform = ? AND t.author_key = ? AND t.user_key < ? ORDER BY t.user_key DESC LIMIT ?`
    ),
    idsByAuthor: db.prepare('SELECT id FROM tweets WHERE platform = ? AND author_key = ?'),
    getAuthor: db.prepare('SELECT * FROM authors WHERE platform = ? AND author_key = ?'),
    insertAuthor: db.prepare(
      'INSERT OR IGNORE INTO authors (platform, author_key, user_id, user_name, avatar, updated_at) VALUES (?, ?, ?, ?, NULL, ?)'
    ),
    updateAuthor: db.prepare(
      'UPDATE authors SET user_id = ?, user_name = ?, updated_at = ? WHERE platform = ? AND author_key = ?'
    ),
    updateAuthorAvatar: db.prepare(
      'UPDATE authors SET avatar = ?, updated_at = ? WHERE platform = ? AND author_key = ?'
    ),
    insertAuthorName: db.prepare(
      'INSERT OR IGNORE INTO author_names (platform, author_key, user_name, from_at, to_at) VALUES (?, ?, ?, ?, ?)'
    ),
    closeAuthorName: db.prepare(
      'UPDATE author_names SET to_at = ? WHERE platform = ? AND author_key = ? AND user_name = ? AND to_at IS NULL'
    ),
  };

  // 记录对象（id 为组合 ID「platform:rawId」）→ 数据库行
  function recordToRow(t) {
    const savedAt = t.savedAt || new Date().toISOString();
    const platform = str(t.platform) || 'x';
    const id = str(t.id);
    const ms = tweetTimeMsOf(t.tweetTime);
    return {
      id,
      platform,
      author_key: str(t.authorKey) || str(t.userId),
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
      tl_key: tlKeyOf(savedAt, id),
      user_key: userKeyOf(ms, savedAt, id),
    };
  }

  function rowToItem(r) {
    return {
      id: r.id, // 组合 ID（platform:rawId），界面与删除接口都用它
      platform: r.platform || 'x',
      authorKey: r.author_key || r.user_id, // 稳定作者键（抖音=sec_uid，X=handle），视图分组用
      url: r.url,
      // 展示作者表的当前值：改名/改抖音号后旧卡片同步；快照仍在行内 user_name/user_id
      userName: r.a_name || r.user_name,
      userId: r.a_uid || r.user_id,
      avatar: r.a_avatar || r.avatar,
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
          // 旧存档均为 X(Twitter) 推文：补 platform 并换算成组合 ID
          if (t && /^\d{5,25}$/.test(String(t.id))) rows.push(recordToRow({ ...t, platform: 'x', id: 'x:' + t.id }));
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

  /** 该推文是否已存在（id 为组合 ID「platform:rawId」） */
  async function existsTweet(id) {
    const rid = parseRid(id);
    if (!rid) return false;
    return !!stmts.get.get(rid.platform + ':' + rid.rawId);
  }

  /**
   * 写入/更新作者当前身份（authorKey 为稳定键：抖音=sec_uid，X=handle）。
   * 名字变化时在 author_names 里保留历史：旧行闭区间（to_at=本次时间），新行开区间。
   * 展示 ID（抖音号/handle）跟随最新一次保存。返回是否发生了改名。
   */
  function upsertAuthor(platform, authorKey, userId, userName, at) {
    const cur = stmts.getAuthor.get(platform, authorKey);
    if (!cur) {
      stmts.insertAuthor.run(platform, authorKey, str(userId), str(userName), at);
      stmts.insertAuthorName.run(platform, authorKey, str(userName), at, null);
      return false; // 新作者不算改名
    }
    const renamed = !!str(userName) && str(userName) !== cur.user_name;
    stmts.updateAuthor.run(str(userId) || cur.user_id, renamed ? str(userName) : cur.user_name, at, platform, authorKey);
    if (renamed) {
      stmts.closeAuthorName.run(at, platform, authorKey, cur.user_name);
      stmts.insertAuthorName.run(platform, authorKey, str(userName), at, null);
    }
    return renamed;
  }

  // 作者改名/换头像后，其所有推文的展示字段都来自作者表——
  // 逐条补发 upsert，让已打开界面上的旧卡片同步刷新
  async function notifyAuthorTweets(platform, authorKey) {
    for (const r of stmts.idsByAuthor.all(platform, authorKey)) {
      const rec = getRecord(r.id);
      if (rec) notify('upsert', rec);
    }
  }

  /**
   * 接收扩展上传的媒体二进制，写入暂存区 <fileSafeId>-<index>[-poster].<ext>
   * （写入 .tmp 再改名，避免半截文件被当成完整上传）
   */
  async function uploadMedia({ id, index, role, ext, contentType, stream }) {
    const rid = parseRid(id);
    if (!rid) throw new Error('无效的作品 ID');
    if (!(Number.isInteger(index) && index >= 0 && index <= 19)) throw new Error('无效的媒体序号');
    const fid = fileSafeId(rid.platform + ':' + rid.rawId);
    const suffix = role === 'poster' ? '-poster' : '';
    let finalExt = extFromMime(contentType);
    if (!finalExt && /^\.[a-z0-9]{2,5}$/i.test(str(ext))) finalExt = str(ext).toLowerCase();
    if (!ALLOWED_EXTS.has(finalExt)) finalExt = String(contentType).indexOf('video') !== -1 ? '.mp4' : '.jpg';

    await ensureDirs();
    const tmp = path.join(dirs.staging, `${fid}-${index}${suffix}${finalExt}.tmp`);
    const fin = path.join(dirs.staging, `${fid}-${index}${suffix}${finalExt}`);

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

  /** 从暂存区取走 <fileSafeId>-<index><suffix>.<ext> 并移入正式目录；没有则返回 null */
  async function takeStaged(rid, index, suffix, destKind) {
    const fid = fileSafeId(rid);
    let files = [];
    try {
      files = await fsp.readdir(dirs.staging);
    } catch (e) {
      return null;
    }
    const prefix = `${fid}-${index}${suffix}.`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const ext = '.' + f.slice(prefix.length).toLowerCase();
      if (ext === '.tmp' || !ALLOWED_EXTS.has(ext)) continue;
      const folder = destKind === 'video' ? 'videos' : 'images';
      const name = `${fid}-${index}${suffix}${ext}`;
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
    const fid = fileSafeId(id);
    try {
      for (const f of await fsp.readdir(dirs.staging)) {
        if (f.startsWith(fid + '-')) await fsp.rm(path.join(dirs.staging, f), { force: true });
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 保存一条推文。媒体优先使用扩展预上传的暂存文件（随元信息一并入库）；
   * 缺失的媒体项（扩展下载失败等）由服务端按 URL 兜底下载并在完成后更新。
   * payload.platform 标识来源平台（x / douyin…），与平台原始 ID 一起组合成唯一主键。
   */
  async function saveTweet(payload) {
    await ensureDirs();
    const platform = str(payload && payload.platform).trim() || 'x';
    if (!RE_PLATFORM.test(platform)) throw new Error('无效的平台标识');
    const rawId = str(payload && payload.id).trim();
    if (!RE_RAW_ID.test(rawId)) throw new Error('无效的作品 ID');
    const id = platform + ':' + rawId;
    // 稳定作者键：抖音传 sec_uid；缺省（旧版扩展/X）回退展示 ID
    let authorKey = str(payload && payload.authorKey).trim() || str(payload && payload.userId).trim();
    if (authorKey && !RE_RAW_ID.test(authorKey)) authorKey = '';

    if (stmts.get.get(id)) {
      await cleanStaging(id);
      return { duplicate: true };
    }

    const record = {
      id,
      platform,
      authorKey,
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
          missReason: str(m.missReason) || null, // 直链与 HLS 都没抓到时的原因（诊断用）
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

    // 作者身份入库：改名时保留历史，并广播该作者全部旧卡片刷新
    if (authorKey) {
      const renamed = upsertAuthor(platform, authorKey, str(payload.userId), str(payload.userName), record.savedAt);
      if (renamed) enqueue(() => notifyAuthorTweets(platform, authorKey));
    }

    if (payload.avatarUrl || fallbacks.length) {
      enqueue(() => finishFallbacks(id, payload, fallbacks));
    }
    return { duplicate: false };
  }

  async function finishFallbacks(id, payload, fallbacks) {
    const record = getRecord(id);
    if (!record) return;
    let dirty = false;
    let authorAvatarRefreshed = false;

    // 头像属于作者（authors 表共享），按「平台_作者键」命名；
    // 每次保存都刷新文件，该作者的所有旧卡片同步换新头像
    if (payload.avatarUrl && record.authorKey) {
      const name =
        fileSafeId(record.platform + '_' + sanitizeName(record.authorKey)) + extFor(payload.avatarUrl, '.jpg');
      const rel = 'media/avatars/' + name;
      if (await downloadTo(payload.avatarUrl, path.join(dataDir, rel))) {
        stmts.updateAuthorAvatar.run(rel, new Date().toISOString(), record.platform, record.authorKey);
        authorAvatarRefreshed = true;
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
        const rel = `media/images/${fileSafeId(record.id)}-${fb.index}-poster` + extFor(fb.url, '.jpg');
        if (await downloadTo(fb.url, path.join(dataDir, rel))) {
          entry.posterPath = rel;
          dirty = true;
        }
      } else {
        if (entry.path) continue;
        const isVideo = entry.kind === 'video';
        const folder = isVideo ? 'videos' : 'images';
        const rel = `media/${folder}/${fileSafeId(record.id)}-${fb.index}` + (isVideo ? '.mp4' : extFor(fb.url, '.jpg'));
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
    if (authorAvatarRefreshed) await notifyAuthorTweets(record.platform, record.authorKey);
  }

  /**
   * 删除一条推文：删除其数据库记录，并一并删除该推文专属的
   * 图片/视频/封面文件（头像按 handle 命名、可能被其他推文共用，保留）。
   */
  async function deleteTweet(id) {
    const rid = parseRid(id);
    if (!rid) throw new Error('无效的作品 ID');
    id = rid.platform + ':' + rid.rawId;
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
   * @param {{view?: 'timeline'|'user', platform?: string, authorKey?: string, userId?: string, cursor?: string|null, limit?: number}} opts
   *   作者视图按稳定作者键（authorKey，抖音=sec_uid）分组；userId 为旧调用兼容别名
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
      const platform = str(o.platform) || 'x';
      const akey = str(o.authorKey) || str(o.userId);
      total = stmts.countUser.get(platform, akey).c;
      rows = cursor ? stmts.userAfter.all(platform, akey, cursor, limit) : stmts.userFirst.all(platform, akey, limit);
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
    if (o.view === 'user') {
      return stmts.countUser.get(str(o.platform) || 'x', str(o.authorKey) || str(o.userId)).c;
    }
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

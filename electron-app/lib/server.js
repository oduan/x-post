'use strict';

// 本地 HTTP 接口：只监听 127.0.0.1 的固定高位端口，用于接收浏览器扩展推送的推文数据

const http = require('http');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // 允许 https 页面向本机回环地址发起请求（Chrome Private Network Access 预检）
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * @param {number} port 监听端口
 * @param {(payload: object) => Promise<{duplicate?: boolean}>} onSaveTweet 收到推文元信息时的回调
 * @param {(info: object) => Promise<void>} onUploadMedia 收到媒体二进制时的回调
 * @param {(id: string) => Promise<boolean>} existsTweet 查询推文是否已存在的回调
 */
function startServer(port, onSaveTweet, onUploadMedia, existsTweet) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && (url === '/api/ping' || url === '/ping')) {
        sendJson(res, 200, { ok: true, app: 'x-post' });
        return;
      }
      if (req.method === 'GET' && url === '/api/tweets/exists') {
        const id = str(new URL(req.url, 'http://x').searchParams.get('id') || '');
        const found = typeof existsTweet === 'function' ? await existsTweet(id) : false;
        sendJson(res, 200, { ok: true, exists: !!found });
        return;
      }
      if (req.method === 'POST' && url === '/api/media') {
        const id = str(req.headers['x-tweet-id']);
        const index = parseInt(req.headers['x-media-index'], 10);
        const role = str(req.headers['x-media-role']) || 'main';
        const ext = str(req.headers['x-media-ext']);
        if (!/^\d{5,25}$/.test(id) || !(index >= 0 && index <= 19) || ['main', 'poster'].indexOf(role) === -1) {
          sendJson(res, 400, { ok: false, error: '无效的媒体上传请求' });
          return;
        }
        try {
          await onUploadMedia({ id, index, role, ext, contentType: str(req.headers['content-type']), stream: req });
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e) });
        }
        return;
      }
      if (req.method === 'POST' && url === '/api/tweets') {
        const raw = await readBody(req, 32 * 1024 * 1024);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: '无效的 JSON 数据' });
          return;
        }
        const result = await onSaveTweet(payload);
        sendJson(res, 200, Object.assign({ ok: true }, result || {}));
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startServer };

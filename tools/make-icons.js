'use strict';

/**
 * 生成扩展图标（蓝底白色 X 的圆角方形），纯 Node 实现，无第三方依赖。
 * 用法：node tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 最小 PNG 编码器 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制（4x 超采样抗锯齿） ----------

function roundedRectHit(x, y, s, r) {
  const m = 0.5;
  if (x < m || y < m || x > s - m || y > s - m) return false;
  const rx = Math.max(Math.abs(x - s / 2) - (s / 2 - m - r), 0);
  const ry = Math.max(Math.abs(y - s / 2) - (s / 2 - m - r), 0);
  return rx * rx + ry * ry <= r * r;
}

function xMarkHit(x, y, s, stroke) {
  const c = s / 2;
  const half = 0.23 * s;
  if (Math.abs(x - c) > half || Math.abs(y - c) > half) return false;
  const d1 = Math.abs(x - c + (y - c)) / Math.SQRT2;
  const d2 = Math.abs(x - c - (y - c)) / Math.SQRT2;
  return d1 <= stroke / 2 || d2 <= stroke / 2;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // 超采样倍数
  const R = 0.225 * size;
  const stroke = 0.16 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0;
      let xHit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px_ = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (!roundedRectHit(px_, py, size, R)) continue;
          bgHit++;
          if (xMarkHit(px_, py, size, stroke)) xHit++;
        }
      }
      const total = S * S;
      const i = (y * size + x) * 4;
      if (xHit > 0) {
        const a = xHit / total;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = Math.round(255 * a);
      } else if (bgHit > 0) {
        const a = bgHit / total;
        px[i] = 29; // #1d9bf0
        px[i + 1] = 155;
        px[i + 2] = 240;
        px[i + 3] = Math.round(255 * a);
      }
    }
  }
  return px;
}

// ---------- 输出 ----------

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`写入 ${file} (${png.length} 字节)`);
}
console.log('图标生成完成');

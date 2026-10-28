/**
 * 生成 PWA 图标（纯 Node，无第三方依赖）
 *
 * 为什么自己画：
 *   项目要「零外部资源」交付，图标不能从网上下载；装 canvas / sharp 又太重。
 *   这里直接写 PNG：RGBA 像素 → zlib 压缩 → 拼 IHDR/IDAT/IEND 三个块。
 *
 * 用法：node tools/gen-icons.js
 * 产物：assets/icon-192.png、assets/icon-512.png、assets/icon-maskable-512.png
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- 最小 PNG 编码器 ---------------- */

function crc32(buf) {
    let c;
    const table = crc32.table || (crc32.table = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })());
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type: RGBA
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace

    // 每行前面加一个 filter 字节（0 = None）
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/* ---------------- 绘图 ---------------- */

function drawIcon(size, opts) {
    opts = opts || {};
    const maskable = !!opts.maskable;
    const buf = Buffer.alloc(size * size * 4);

    const wood = [212, 165, 116];
    const woodDark = [176, 130, 84];
    const line = [101, 67, 33];
    const black = [26, 26, 26];
    const white = [248, 248, 248];

    // maskable 版本：内容缩到 80%，留出安全边距
    const inset = maskable ? size * 0.1 : 0;
    const boardSize = size - inset * 2;

    const radius = size * 0.18;
    const put = (x, y, c, a) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const i = (y * size + x) * 4;
        const alpha = a === undefined ? 1 : a;
        if (alpha >= 1) {
            buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
        } else {
            const ia = 1 - alpha;
            buf[i] = Math.round(c[0] * alpha + buf[i] * ia);
            buf[i + 1] = Math.round(c[1] * alpha + buf[i + 1] * ia);
            buf[i + 2] = Math.round(c[2] * alpha + buf[i + 2] * ia);
            buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * alpha));
        }
    };

    // 背景（带圆角）
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let inside = true;
            if (radius > 0) {
                const dx = Math.min(x, size - 1 - x);
                const dy = Math.min(y, size - 1 - y);
                if (dx < radius && dy < radius) {
                    const d = Math.hypot(radius - dx, radius - dy);
                    inside = d <= radius;
                }
            }
            if (!inside) continue;
            // 纵向木纹渐变
            const t = y / size;
            const c = [
                Math.round(wood[0] * (1 - t * 0.25) + woodDark[0] * t * 0.25),
                Math.round(wood[1] * (1 - t * 0.25) + woodDark[1] * t * 0.25),
                Math.round(wood[2] * (1 - t * 0.25) + woodDark[2] * t * 0.25)
            ];
            put(x, y, c, 1);
        }
    }

    // 网格 7 条线（棋盘 15 路，图标只画局部）
    const pad = inset + boardSize * 0.18;
    const gridLen = boardSize * 0.64;
    const step = gridLen / 4;
    const lw = Math.max(1, Math.round(size * 0.012));

    const drawLineH = (yy) => {
        for (let x = Math.round(pad); x <= pad + gridLen; x++) {
            for (let k = -Math.floor(lw / 2); k <= Math.floor(lw / 2); k++) {
                put(x, Math.round(yy) + k, line, 0.85);
            }
        }
    };
    const drawLineV = (xx) => {
        for (let y = Math.round(pad); y <= pad + gridLen; y++) {
            for (let k = -Math.floor(lw / 2); k <= Math.floor(lw / 2); k++) {
                put(Math.round(xx) + k, y, line, 0.85);
            }
        }
    };
    for (let i = 0; i <= 4; i++) {
        drawLineH(pad + i * step);
        drawLineV(pad + i * step);
    }

    // 棋子
    const stoneR = gridLen / 8;
    const circle = (cx, cy, r, col, border) => {
        for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) {
            for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
                const d = Math.hypot(x - cx, y - cy);
                if (d > r) continue;
                // 边缘 1px 抗锯齿
                const a = d > r - 1 ? 0.55 : 1;
                put(x, y, col, a);
                if (border && d > r - Math.max(1.5, size * 0.008)) put(x, y, border, 0.9);
            }
        }
    };

    circle(pad + step * 2, pad + step * 2, stoneR, black, [0, 0, 0]);
    circle(pad + step * 3, pad + step * 1, stoneR, white, [170, 170, 170]);
    circle(pad + step * 1, pad + step * 3, stoneR, white, [170, 170, 170]);

    return buf;
}

/* ---------------- 主流程 ---------------- */

const outDir = path.resolve(__dirname, '..', 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const jobs = [
    { file: 'icon-192.png', size: 192, opts: {} },
    { file: 'icon-512.png', size: 512, opts: {} },
    { file: 'icon-maskable-512.png', size: 512, opts: { maskable: true } }
];

for (const job of jobs) {
    const rgba = drawIcon(job.size, job.opts);
    const png = encodePNG(job.size, job.size, rgba);
    fs.writeFileSync(path.join(outDir, job.file), png);
    console.log(job.file + '  ' + job.size + 'x' + job.size + '  ' + png.length + ' B');
}

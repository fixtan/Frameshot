// @ts-check
'use strict';

const sharp = require('sharp');
const { LIMITS } = require('../shared/config');

/**
 * @typedef {Object} StillOptions
 * @property {number} width 撮影サイズ（CSS px）
 * @property {number} height
 * @property {number} scale 解像度倍率
 * @property {import('../shared/config').StillFormat} format
 * @property {number} quality
 * @property {boolean} lossless WebP のみ
 * @property {boolean} [encode] false なら PNG のまま返す（クリップボード用）
 */

/**
 * @typedef {Object} StillResult
 * @property {Buffer} png CDP が返した元の PNG（劣化なし）
 * @property {Buffer} buffer 保存する中身（encode が false なら png と同じ）
 * @property {string} ext
 * @property {number} width 出力ピクセル
 * @property {number} height
 */

/**
 * 出力サイズが撮れる大きさか確かめる。ダメなら理由つきで例外
 * @param {number} outW
 * @param {number} outH
 * @param {string} format
 */
function assertOutputSize(outW, outH, format) {
  const edge = Math.max(outW, outH);
  if (edge > LIMITS.maxEdgePx) {
    throw new Error(`出力が大きすぎます（${outW}×${outH}px）。片辺 ${LIMITS.maxEdgePx}px まで。サイズか倍率を下げてください`);
  }
  if (format === 'webp' && edge > LIMITS.webpMaxEdgePx) {
    throw new Error(`WebP は片辺 ${LIMITS.webpMaxEdgePx}px までです（${outW}×${outH}px）。PNG か JPG を使ってください`);
  }
}

/**
 * 枠の中身を静止画として撮る。画面の大きさには依存しない
 * （ページ自体を撮影サイズ・倍率でレンダリングして、その全体を撮る）
 * @param {InstanceType<typeof import('./frame').Frame>} frame
 * @param {StillOptions} opts
 * @returns {Promise<StillResult>}
 */
async function captureStill(frame, opts) {
  const { width, height, scale, format, quality, lossless } = opts;
  assertOutputSize(width * scale, height * scale, format);

  const png = await frame.runCapture(scale, async (send) => {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(r.data, 'base64');
  });

  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const outW = meta.width ?? width * scale;
  const outH = meta.height ?? height * scale;

  if (opts.encode === false || format === 'png') {
    return { png, buffer: png, ext: 'png', width: outW, height: outH };
  }

  const img = sharp(png, { limitInputPixels: false });
  if (format === 'jpg') {
    const buffer = await img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    return { png, buffer, ext: 'jpg', width: outW, height: outH };
  }
  const buffer = await img.webp({ quality, lossless, effort: 4 }).toBuffer();
  return { png, buffer, ext: 'webp', width: outW, height: outH };
}

module.exports = { captureStill, assertOutputSize };

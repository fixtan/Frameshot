// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 同名ファイルがあれば _2, _3 … を付けて保存する（上書きしない）
 * @param {string} dir
 * @param {string} baseName 拡張子なし
 * @param {string} ext
 * @param {Buffer} buffer
 * @returns {Promise<string>} 保存したファイルのパス
 */
async function writeUnique(dir, baseName, ext, buffer) {
  await fs.promises.mkdir(dir, { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const file = path.join(dir, i === 1 ? `${baseName}.${ext}` : `${baseName}_${i}.${ext}`);
    try {
      await fs.promises.writeFile(file, buffer, { flag: 'wx' });
      return file;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('同じ名前のファイルが多すぎます。ファイル名テンプレートに {time} を含めてください');
}

/**
 * まだ存在しないファイル名を決める（同名があれば _2, _3 …）。ffmpeg など、外部プロセスが書く出力用
 * @param {string} dir
 * @param {string} baseName 拡張子なし
 * @param {string} ext
 * @returns {Promise<string>}
 */
async function uniquePath(dir, baseName, ext) {
  await fs.promises.mkdir(dir, { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const file = path.join(dir, i === 1 ? `${baseName}.${ext}` : `${baseName}_${i}.${ext}`);
    const taken = await Promise.all([file, `${file}.part`].map((f) => fs.promises.access(f).then(() => true, () => false)));
    if (!taken.some(Boolean)) return file;
  }
  throw new Error('同じ名前のファイルが多すぎます。ファイル名テンプレートに {time} を含めてください');
}

/** @param {number} n */
function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

module.exports = { writeUnique, uniquePath, formatBytes };

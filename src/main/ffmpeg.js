// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * 同梱の ffmpeg（ffmpeg-static）のパス。パッケージ版では app.asar の中は実行できないので、
 * asarUnpack で展開された app.asar.unpacked 側を指す
 * @returns {string | null}
 */
function bundledPath() {
  try {
    const p = /** @type {string | null} */ (/** @type {unknown} */ (require('ffmpeg-static')));
    if (!p) return null;
    const fixed = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(fixed) ? fixed : null;
  } catch {
    return null;
  }
}

/** PATH 上の ffmpeg が動くか */
function systemWorks() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 使う ffmpeg を決める。設定で指定されたもの → 同梱 → PATH 上、の順
 * @param {string} custom 設定の ffmpegPath（空なら指定なし）
 * @returns {{ path: string, source: 'custom' | 'bundled' | 'system' } | { error: string }}
 */
function resolveFfmpeg(custom) {
  if (custom) {
    if (fs.existsSync(custom)) return { path: custom, source: 'custom' };
    return { error: `設定の ffmpeg が見つかりません: ${custom}` };
  }
  const b = bundledPath();
  if (b) return { path: b, source: 'bundled' };
  if (systemWorks()) return { path: 'ffmpeg', source: 'system' };
  return { error: 'ffmpeg が見つかりません。同梱の ffmpeg が壊れているか、PATH 上にありません' };
}

module.exports = { resolveFfmpeg };

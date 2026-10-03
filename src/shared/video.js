// @ts-check
'use strict';

// 動画まわりの純粋な処理（Electron にも ffmpeg にも依存しない。test/ でそのまま試験できる）

const VIDEO = Object.freeze({
  fpsChoices: Object.freeze([10, 15, 24, 30]),
  /** 画質プリセット。crf は小さいほど高画質で大きい */
  qualities: Object.freeze({
    light: Object.freeze({ label: '軽量（ギャラリー向け）', crf: 28 }),
    standard: Object.freeze({ label: '標準', crf: 23 }),
    high: Object.freeze({ label: '高画質', crf: 18 }),
  }),
  maxSecChoices: Object.freeze([30, 60, 120, 300, 600]),
  minSec: 1,
  maxSec: 600,
});

/** @typedef {keyof typeof VIDEO.qualities} VideoQuality */

/**
 * H.264（yuv420p）は幅と高さが偶数でないといけない。奇数なら 1px 切り詰める
 * @param {number} width
 * @param {number} height
 */
function evenSize(width, height) {
  return { width: Math.max(2, width - (width % 2)), height: Math.max(2, height - (height % 2)) };
}

/**
 * ffmpeg に渡す引数。生のフレーム（BGRA）を stdin から受けて MP4 にする
 * @param {{ width: number, height: number, fps: number, quality: VideoQuality, outFile: string }} o
 * width / height は入力フレームの大きさ。出力は偶数に切り詰める
 * @returns {string[]}
 */
function buildFfmpegArgs(o) {
  const out = evenSize(o.width, o.height);
  const q = VIDEO.qualities[o.quality] ?? VIDEO.qualities.light;
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',
    '-s', `${o.width}x${o.height}`,
    '-r', String(o.fps),
    '-i', '-',
    '-vf', `crop=${out.width}:${out.height}:0:0`,
    '-an',
    '-c:v', 'libx264',
    '-crf', String(q.crf),
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    // 出力名の拡張子（.part）から形式を推測できないので明示する
    '-f', 'mp4',
    o.outFile,
  ];
}

/**
 * 映像だけの MP4 と、別に録った音声（webm/opus）を 1 つの MP4 にまとめる ffmpeg の引数。
 * 映像はそのままコピーし、音声だけ AAC にする。
 * @param {{ videoFile: string, audioFile: string, audioOffsetMs: number, durationSec: number, outFile: string }} o
 * durationSec: 映像の長さ。出力はこの長さで終わる（音声が短ければ無音で延ばす）
 * audioOffsetMs: 音声の録音開始 − 映像の録画開始（ミリ秒）。正なら音声を遅らせ、負なら音声の頭を切る
 * @returns {string[]}
 */
function buildMuxArgs(o) {
  const off = Math.round(o.audioOffsetMs) / 1000;
  /** @type {string[]} */
  const audioIn = off > 0 ? ['-itsoffset', off.toFixed(3)] : off < 0 ? ['-ss', (-off).toFixed(3)] : [];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', o.videoFile,
    ...audioIn,
    '-i', o.audioFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    // 音声が映像より短いときは無音で延ばし、映像の長さで切る。
    // （-shortest は、映像をコピーしているとき apad と組み合わせると終わらないので使わない）
    '-af', 'apad',
    '-t', Math.max(0.1, o.durationSec).toFixed(3),
    '-movflags', '+faststart',
    '-f', 'mp4',
    o.outFile,
  ];
}

/**
 * 録画開始から elapsedMs 経った時点で、書き終えているべきフレーム数（最初の 1 枚は 0ms ちょうど）
 * @param {number} elapsedMs
 * @param {number} fps
 */
function dueFrames(elapsedMs, fps) {
  return Math.floor((Math.max(0, elapsedMs) * fps) / 1000) + 1;
}

/**
 * 録画を止めたときの総フレーム数（録画時間ぴったりの長さになるように丸める。最低 1 枚）
 * @param {number} elapsedMs
 * @param {number} fps
 */
function totalFrames(elapsedMs, fps) {
  return Math.max(1, Math.round((Math.max(0, elapsedMs) * fps) / 1000));
}

/** 00:07 / 1:02:03 @param {number} ms */
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/**
 * ffmpeg の stderr の末尾を、画面に出せる長さに整える
 * @param {string} text
 * @param {number} [max]
 */
function tailText(text, max = 300) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : '…' + t.slice(t.length - max + 1);
}

module.exports = { VIDEO, evenSize, buildFfmpegArgs, buildMuxArgs, dueFrames, totalFrames, formatDuration, tailText };

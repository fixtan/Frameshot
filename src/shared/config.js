// @ts-check
'use strict';

// 設定の既定値・上限・正規化。Electron に依存しない純粋なモジュール（test/ でそのまま試験できる）

const { VIDEO } = require('./video');

const LIMITS = Object.freeze({
  minSize: 100,
  maxSize: 16384,
  scales: Object.freeze([1, 2, 3]),
  /** GPU テクスチャの上限。出力ピクセル（サイズ × 倍率）の片辺がこれを超えると撮れない */
  maxEdgePx: 16384,
  /** WebP の仕様上の上限 */
  webpMaxEdgePx: 16383,
  maxPresets: 30,
  maxBookmarks: 200,
  maxRecent: 20,
});

/**
 * @typedef {{ name: string, w: number, h: number }} SizePreset
 * @typedef {{ title: string, url: string }} Bookmark
 * @typedef {'png' | 'jpg' | 'webp'} StillFormat
 * @typedef {Object} Settings
 * @property {number} version
 * @property {string} url 最後に開いた URL（http/https のみ）
 * @property {number} width 枠の幅（CSS px）
 * @property {number} height 枠の高さ（CSS px）
 * @property {number} scale 解像度倍率（deviceScaleFactor）
 * @property {StillFormat} format
 * @property {number} quality 1〜100（PNG では無視）
 * @property {boolean} webpLossless
 * @property {string} outputDir 空文字なら既定（ピクチャ/Frameshot）
 * @property {string} nameTemplate
 * @property {boolean} copyToClipboard
 * @property {number} videoFps 動画のフレームレート
 * @property {import('./video').VideoQuality} videoQuality 動画の画質プリセット
 * @property {number} videoMaxSec 録画の最大秒数（超えると自動で止める）
 * @property {boolean} videoAudio 録画に枠の音声を入れる
 * @property {string} ffmpegPath 空文字なら同梱の ffmpeg（なければ PATH 上の ffmpeg）
 * @property {SizePreset[]} presets 自分用プリセット
 * @property {Bookmark[]} bookmarks
 * @property {string[]} recent
 * @property {{ x?: number, y?: number, width: number, height: number }} window
 */

/** 標準プリセット（設定ファイルには保存しない） */
const BUILTIN_PRESETS = Object.freeze([
  { name: 'ギャラリー縦 880×1320', w: 880, h: 1320 },
  { name: 'ギャラリー縦 1024×1536', w: 1024, h: 1536 },
  { name: 'デスクトップ 1280×720', w: 1280, h: 720 },
  { name: 'フルHD 1920×1080', w: 1920, h: 1080 },
  { name: 'OGP 1200×630', w: 1200, h: 630 },
  { name: 'iPhone 390×844', w: 390, h: 844 },
  { name: 'iPad 820×1180', w: 820, h: 1180 },
]);

/** @returns {Settings} */
function defaults() {
  return {
    version: 1,
    url: '',
    width: 880,
    height: 1320,
    scale: 1,
    format: 'webp',
    quality: 88,
    webpLossless: false,
    outputDir: '',
    nameTemplate: '{host}_{date}_{time}_{w}x{h}{scale}',
    copyToClipboard: false,
    videoFps: 15,
    videoQuality: 'light',
    videoMaxSec: 120,
    videoAudio: false,
    ffmpegPath: '',
    presets: [],
    bookmarks: [],
    recent: [],
    window: { width: 1240, height: 900 },
  };
}

/**
 * 数値を整数に丸めて範囲内に収める。数値として読めなければ fallback
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function toInt(v, min, max, fallback) {
  if (typeof v !== 'number' && typeof v !== 'string') return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 項目ごとの検査。第 2 引数は不正だったときに使う値 @type {Record<string, (v: unknown, fallback: any) => any>} */
const FIELD = {
  width: (v, fb) => toInt(v, LIMITS.minSize, LIMITS.maxSize, fb),
  height: (v, fb) => toInt(v, LIMITS.minSize, LIMITS.maxSize, fb),
  scale: (v, fb) => (LIMITS.scales.includes(Number(v)) ? Number(v) : fb),
  format: (v, fb) => (v === 'png' || v === 'jpg' || v === 'webp' ? v : fb),
  quality: (v, fb) => toInt(v, 1, 100, fb),
  webpLossless: (v, fb) => (typeof v === 'boolean' ? v : fb),
  nameTemplate: (v, fb) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : fb),
  copyToClipboard: (v, fb) => (typeof v === 'boolean' ? v : fb),
  videoFps: (v, fb) => (VIDEO.fpsChoices.includes(Number(v)) ? Number(v) : fb),
  videoQuality: (v, fb) => (typeof v === 'string' && Object.hasOwn(VIDEO.qualities, v) ? v : fb),
  videoMaxSec: (v, fb) => toInt(v, VIDEO.minSec, VIDEO.maxSec, fb),
  videoAudio: (v, fb) => (typeof v === 'boolean' ? v : fb),
};

/** UI から変更してよい項目 */
const PATCHABLE = Object.freeze(Object.keys(FIELD));

/** @param {unknown} raw @returns {SizePreset[]} */
function cleanPresets(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {SizePreset[]} */
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 40) : '';
    const w = toInt(p.w, LIMITS.minSize, LIMITS.maxSize, 0);
    const h = toInt(p.h, LIMITS.minSize, LIMITS.maxSize, 0);
    if (!name || !w || !h || out.some((q) => q.name === name)) continue;
    out.push({ name, w, h });
    if (out.length >= LIMITS.maxPresets) break;
  }
  return out;
}

/** @param {unknown} raw @returns {Bookmark[]} */
function cleanBookmarks(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Bookmark[]} */
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object' || typeof b.url !== 'string') continue;
    if (!/^https?:\/\//i.test(b.url) || out.some((q) => q.url === b.url)) continue;
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 120) : b.url;
    out.push({ title, url: b.url });
    if (out.length >= LIMITS.maxBookmarks) break;
  }
  return out;
}

/** @param {unknown} raw @returns {string[]} */
function cleanRecent(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const u of raw) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
    if (out.length >= LIMITS.maxRecent) break;
  }
  return out;
}

/** @param {unknown} raw @returns {Settings['window']} */
function cleanWindow(raw) {
  const d = defaults().window;
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Settings['window']} */
  const w = {
    width: toInt(r.width, 400, 10000, d.width),
    height: toInt(r.height, 300, 10000, d.height),
  };
  if (typeof r.x === 'number' && Number.isFinite(r.x)) w.x = Math.round(r.x);
  if (typeof r.y === 'number' && Number.isFinite(r.y)) w.y = Math.round(r.y);
  return w;
}

/**
 * 読み込んだ設定を検査して、足りない項目は既定値で埋める
 * @param {unknown} raw
 * @returns {Settings}
 */
function normalizeSettings(raw) {
  const d = /** @type {Record<string, any>} */ (defaults());
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  /** @type {Record<string, any>} */
  const out = { version: 1 };
  for (const k of PATCHABLE) out[k] = FIELD[k](r[k], d[k]);
  out.url = typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r.url : '';
  out.outputDir = typeof r.outputDir === 'string' ? r.outputDir : '';
  out.ffmpegPath = typeof r.ffmpegPath === 'string' ? r.ffmpegPath.trim() : '';
  out.presets = cleanPresets(r.presets);
  out.bookmarks = cleanBookmarks(r.bookmarks);
  out.recent = cleanRecent(r.recent);
  out.window = cleanWindow(r.window);
  return /** @type {Settings} */ (out);
}

/**
 * UI から届いた変更を検査して、変更後の設定を返す。不正な値は今の値のまま
 * @param {Settings} current
 * @param {unknown} patch
 * @returns {Settings}
 */
function patchSettings(current, patch) {
  const cur = /** @type {Record<string, any>} */ (current);
  const p = patch && typeof patch === 'object' ? /** @type {Record<string, unknown>} */ (patch) : {};
  /** @type {Record<string, any>} */
  const next = { ...cur };
  for (const k of PATCHABLE) if (k in p) next[k] = FIELD[k](p[k], cur[k]);
  return /** @type {Settings} */ (next);
}

/**
 * 今のサイズに一致するプリセットを探す（自分用を先に見る）
 * @param {readonly SizePreset[]} custom
 * @param {number} w
 * @param {number} h
 * @returns {{ kind: 'custom' | 'builtin', name: string } | null}
 */
function findPreset(custom, w, h) {
  const c = custom.find((p) => p.w === w && p.h === h);
  if (c) return { kind: 'custom', name: c.name };
  const b = BUILTIN_PRESETS.find((p) => p.w === w && p.h === h);
  return b ? { kind: 'builtin', name: b.name } : null;
}

module.exports = {
  LIMITS,
  BUILTIN_PRESETS,
  PATCHABLE,
  defaults,
  toInt,
  normalizeSettings,
  patchSettings,
  findPreset,
};

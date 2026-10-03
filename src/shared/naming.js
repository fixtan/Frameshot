// @ts-check
'use strict';

// 保存ファイル名のテンプレート処理。Electron に依存しない純粋なモジュール

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * @param {number} n
 * @param {number} [len]
 */
const pad = (n, len = 2) => String(n).padStart(len, '0');

/**
 * ローカル時刻の日付（20261003）と時刻（110554）
 * @param {Date} [d]
 */
function stamp(d = new Date()) {
  return {
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

/**
 * URL からファイル名に使うホスト名を取り出す
 * @param {string} url
 */
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local';
    if (u.protocol === 'about:') return 'blank';
    return u.hostname.replace(/^www\./i, '') || 'page';
  } catch {
    return 'page';
  }
}

/**
 * Windows / macOS / Linux のどれでも使えるファイル名にする（拡張子は含めない）
 * @param {string} name
 */
function sanitizeFileName(name) {
  // eslint-disable-next-line no-control-regex
  let s = String(name).normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  s = s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/, '');
  if (RESERVED.test(s)) s = '_' + s;
  return s || 'frameshot';
}

/**
 * @typedef {Object} NameContext
 * @property {string} host
 * @property {string} date 20261003
 * @property {string} time 110554
 * @property {number} width
 * @property {number} height
 * @property {number} scale
 * @property {string} [title]
 */

/**
 * テンプレートの {host} {date} {time} {w} {h} {scale} {title} を埋める。
 * {scale} は 1x のとき空、2x のとき「@2x」。知らない {名前} は空にする
 * @param {string} template
 * @param {NameContext} ctx
 */
function renderName(template, ctx) {
  /** @type {Record<string, string>} */
  const map = {
    host: ctx.host,
    date: ctx.date,
    time: ctx.time,
    w: String(ctx.width),
    h: String(ctx.height),
    scale: ctx.scale > 1 ? `@${ctx.scale}x` : '',
    title: ctx.title ?? '',
  };
  const out = String(template).replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : ''));
  return sanitizeFileName(out);
}

module.exports = { stamp, hostFromUrl, sanitizeFileName, renderName };

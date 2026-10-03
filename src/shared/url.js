// @ts-check
'use strict';

// URL バーに打たれた文字列を、開いてよい URL に直す。Electron に依存しない純粋なモジュール

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * 枠の中で開いてよい URL か
 * @param {string} url
 */
function isAllowedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** @param {string} u @returns {{ url: string } | { error: string }} */
function tryUrl(u) {
  try {
    const parsed = new URL(u);
    if (!isAllowedUrl(parsed.href)) return { error: `対応していないスキームです: ${parsed.protocol}` };
    return { url: parsed.href };
  } catch {
    return { error: `URL として読めません: ${u}` };
  }
}

/**
 * @param {string} input
 * @returns {{ url: string } | { error: string }}
 */
function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'URL が空です' };
  if (raw === 'about:blank') return { url: raw };

  // Windows のパス（C:\dir\a.html）→ file URL
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    const p = encodeURI(raw.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return tryUrl('file:///' + p);
  }

  // スキーム付き
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^file:/i.test(raw)) return tryUrl(raw);

  // 開いてはいけない／開けないスキーム
  const bad = /^(javascript|data|mailto|blob|chrome|devtools|about|view-source|ftp|tel):/i.exec(raw);
  if (bad) return { error: `対応していないスキームです: ${bad[1].toLowerCase()}:` };

  // localhost・IP アドレス・IPv6 は http
  if (/^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(raw)) {
    return tryUrl('http://' + raw);
  }

  // ドット入りのホスト名（example.com/path）は https
  if (!/\s/.test(raw) && /^[^\s/?#]+\.[^\s/?#]+/.test(raw)) return tryUrl('https://' + raw);

  // それ以外は検索
  return { url: 'https://www.google.com/search?q=' + encodeURIComponent(raw) };
}

module.exports = { normalizeUrl, isAllowedUrl };

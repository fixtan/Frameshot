// @ts-check
'use strict';

// ブックマーク・最近開いた URL・自分用プリセットの操作。どれも新しい配列を返す（元は変えない）

const { LIMITS } = require('./config');

/** @typedef {import('./config').Bookmark} Bookmark */
/** @typedef {import('./config').SizePreset} SizePreset */

/**
 * @param {readonly Bookmark[]} list
 * @param {string} url
 */
const isBookmarked = (list, url) => list.some((b) => b.url === url);

/**
 * あれば外し、なければ追加する
 * @param {readonly Bookmark[]} list
 * @param {string} url
 * @param {string} title
 * @returns {Bookmark[]}
 */
function toggleBookmark(list, url, title) {
  if (isBookmarked(list, url)) return list.filter((b) => b.url !== url);
  if (!/^https?:\/\//i.test(url) || list.length >= LIMITS.maxBookmarks) return [...list];
  return [...list, { title: title.trim().slice(0, 120) || url, url }];
}

/**
 * @param {readonly Bookmark[]} list
 * @param {number} index
 * @param {number} delta -1 で上、+1 で下
 * @returns {Bookmark[]}
 */
function moveBookmark(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * @param {readonly Bookmark[]} list
 * @param {number} index
 * @returns {Bookmark[]}
 */
const removeBookmarkAt = (list, index) => list.filter((_, i) => i !== index);

/**
 * 最近開いた URL を先頭に追加する（http/https のみ・重複なし・件数上限あり）
 * @param {readonly string[]} list
 * @param {string} url
 * @returns {string[]}
 */
function pushRecent(list, url) {
  if (!/^https?:\/\//i.test(url)) return [...list];
  return [url, ...list.filter((u) => u !== url)].slice(0, LIMITS.maxRecent);
}

/**
 * 同じ名前があれば上書き、なければ末尾に追加する
 * @param {readonly SizePreset[]} list
 * @param {string} name
 * @param {number} w
 * @param {number} h
 * @returns {SizePreset[]}
 */
function addPreset(list, name, w, h) {
  const n = name.trim().slice(0, 40);
  if (!n) return [...list];
  const entry = { name: n, w, h };
  if (list.some((p) => p.name === n)) return list.map((p) => (p.name === n ? entry : p));
  if (list.length >= LIMITS.maxPresets) return [...list];
  return [...list, entry];
}

/**
 * @param {readonly SizePreset[]} list
 * @param {string} name
 * @returns {SizePreset[]}
 */
const removePreset = (list, name) => list.filter((p) => p.name !== name);

module.exports = {
  isBookmarked,
  toggleBookmark,
  moveBookmark,
  removeBookmarkAt,
  pushRecent,
  addPreset,
  removePreset,
};

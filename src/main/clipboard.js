// @ts-check
'use strict';

const { clipboard, ClipboardItem } = require('electron');

/**
 * PNG 画像をクリップボードに入れる。
 * Electron 44 のクリップボードは非同期の W3C 形式（従来の writeImage は無い）
 * @param {Buffer} png
 */
async function copyPng(png) {
  const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

module.exports = { copyPng };

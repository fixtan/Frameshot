// @ts-check
'use strict';

// ツールバー UI にだけ渡す窓口。外部サイトを開く枠（WebContentsView）には preload を付けない。
// サンドボックス内の preload は他のファイルを require できないので、このファイルだけで完結させる

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @template T
 * @param {string} channel
 * @param {(payload: T) => void} cb
 * @returns {() => void}
 */
function subscribe(channel, cb) {
  /** @param {unknown} _e @param {T} payload */
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/** @type {import('../shared/types').FrameshotApi} */
const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  navigate: (input) => ipcRenderer.invoke('nav:go', String(input)),
  nav: (action) => ipcRenderer.invoke('nav:action', action),
  patch: (patch) => ipcRenderer.invoke('settings:patch', patch),
  captureStill: (mode) => ipcRenderer.invoke('capture:still', mode),
  toggleRecord: () => ipcRenderer.invoke('record:toggle'),
  showVideoMenu: () => ipcRenderer.invoke('video:menu'),
  chooseOutputDir: () => ipcRenderer.invoke('output:choose'),
  openOutputDir: () => ipcRenderer.invoke('output:open'),
  toggleBookmark: () => ipcRenderer.invoke('bookmarks:toggle'),
  showBookmarks: () => ipcRenderer.invoke('bookmarks:menu'),
  addPreset: (name) => ipcRenderer.invoke('presets:add', String(name)),
  removePreset: (name) => ipcRenderer.invoke('presets:remove', String(name)),
  onState: (cb) => subscribe('state', cb),
  onStatus: (cb) => subscribe('status', cb),
  onFocusUrl: (cb) => subscribe('focus-url', cb),
};

contextBridge.exposeInMainWorld('frameshot', api);

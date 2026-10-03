// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, screen, session } = require('electron');

const { Store } = require('./store');
const { Frame } = require('./frame');
const { captureStill } = require('./capture');
const { copyPng } = require('./clipboard');
const { writeUnique, uniquePath, formatBytes } = require('./output');
const { Recorder } = require('./record');
const { PageAudio, installDisplayMediaHandler } = require('./audio');
const { resolveFfmpeg } = require('./ffmpeg');
const { VIDEO, formatDuration } = require('../shared/video');
const { BUILTIN_PRESETS, patchSettings, LIMITS } = require('../shared/config');
const { normalizeUrl, isAllowedUrl } = require('../shared/url');
const { renderName, stamp, hostFromUrl } = require('../shared/naming');
const lists = require('../shared/lists');

/** @typedef {import('../shared/types').FrameshotState} FrameshotState */
/** @typedef {import('../shared/types').CaptureResponse} CaptureResponse */
/** @typedef {import('../shared/types').StatusKind} StatusKind */
/** @typedef {InstanceType<typeof Frame>} FrameT */
/** @typedef {InstanceType<typeof Store>} StoreT */

// レイアウト（src/renderer/style.css の --top / --bottom と揃える）
const CHROME = { top: 96, bottom: 30, margin: 14 };
const PARTITION = 'persist:frameshot'; // ログイン状態を残す
const START_PAGE = path.join(__dirname, '../renderer/start.html');

// 動作確認用: GPU のない環境（VM・リモートデスクトップ）で描画できるようにする。
// 外部ページを開くアプリなので、通常は有効にしない
if (process.env.FRAMESHOT_SOFTWARE_GL === '1') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

/** @type {StoreT} */
let store;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {FrameT | null} */
let frame = null;
let capturing = false;
/** @type {InstanceType<typeof Recorder> | null} */
let recorder = null;
/** @type {NodeJS.Timeout | undefined} */
let recTimer;
/** 録画の設定（録画を始めた時点の値。録画中に変えられる設定は反映しない） @type {{ fps: number, width: number, height: number } | null} */
let recInfo = null;
/** 録画に音声を入れるか（録画を始めた時点の設定） */
let recWithAudio = false;

// ---------- 小道具 ----------

/** @param {string} channel @param {unknown} [payload] */
function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

/** @param {string} message @param {StatusKind} [kind] */
function setStatus(message, kind = 'info') {
  send('status', { message, kind });
}

const effectiveOutputDir = () => store.data.outputDir || path.join(app.getPath('pictures'), 'Frameshot');

/** メニューのラベル用（Windows で & が下線になるのを防ぐ） */
const esc = (/** @type {string} */ s) => s.replace(/&/g, '&&');
const truncate = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** @param {{ x: number, y: number, width: number, height: number }} b */
function onScreen(b) {
  return screen
    .getAllDisplays()
    .some(({ workArea: a }) => b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40);
}

// ---------- 状態を UI へ ----------

let statePending = false;
function scheduleState() {
  if (statePending) return;
  statePending = true;
  setTimeout(() => {
    statePending = false;
    if (frame) send('state', buildState());
  }, 16);
}

/** @returns {FrameshotState} */
function buildState() {
  const s = store.data;
  const f = /** @type {FrameT} */ (frame);
  const wc = f.wc;
  const url = wc.isDestroyed() ? '' : wc.getURL();
  const isStart = url.startsWith('file:') && url.endsWith('/renderer/start.html');
  return {
    url: isStart ? '' : url,
    title: wc.isDestroyed() ? '' : wc.getTitle(),
    canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
    canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
    loading: !wc.isDestroyed() && wc.isLoading(),
    bookmarked: lists.isBookmarked(s.bookmarks, url),
    bookmarkable: /^https?:\/\//i.test(url),
    width: s.width,
    height: s.height,
    scale: s.scale,
    format: s.format,
    quality: s.quality,
    webpLossless: s.webpLossless,
    nameTemplate: s.nameTemplate,
    copyToClipboard: s.copyToClipboard,
    outputDir: effectiveOutputDir(),
    builtinPresets: BUILTIN_PRESETS.map((p) => ({ ...p })),
    presets: s.presets,
    outWidth: s.width * s.scale,
    outHeight: s.height * s.scale,
    fit: f.fit,
    rect: f.rect,
    busy: capturing || recorder?.active === true,
    recording: recorder?.active === true,
    videoFps: s.videoFps,
    videoQuality: s.videoQuality,
    videoMaxSec: s.videoMaxSec,
    videoAudio: s.videoAudio,
  };
}

function relayout() {
  if (!win || win.isDestroyed() || !frame) return;
  const [cw, ch] = win.getContentSize();
  frame.layout(cw, ch, CHROME);
  scheduleState();
}

// ---------- 枠（外部サイト）----------

function hardenSession() {
  const ses = session.fromPartition(PARTITION);
  // カメラ・マイク・通知・位置情報などは一律で断る
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

/** @param {string} url */
function noteVisit(url) {
  if (!/^https?:\/\//i.test(url)) return;
  store.update({ url, recent: lists.pushRecent(store.data.recent, url) });
}

function wirePageEvents() {
  const wc = /** @type {FrameT} */ (frame).wc;
  wc.on('did-start-loading', scheduleState);
  wc.on('did-stop-loading', scheduleState);
  wc.on('page-title-updated', scheduleState);
  wc.on('did-navigate', (_e, url) => {
    noteVisit(url);
    scheduleState();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) noteVisit(url);
    scheduleState();
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 は「別の読み込みに切り替わった」だけなので無視
    if (isMainFrame && code !== -3) setStatus(`読み込めません: ${desc} (${code}) ${truncate(url, 80)}`, 'error');
  });
  wc.on('render-process-gone', (_e, d) => setStatus(`ページが落ちました: ${d.reason}`, 'error'));

  // target=_blank や window.open は、新しい窓を作らず枠の中で開く
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  /** @param {Electron.Event} e @param {string} url */
  const guard = (e, url) => {
    // 非対応のスキームは開かない。外部サイトから file: へも飛ばさない
    if (!isAllowedUrl(url) || (url.startsWith('file:') && !wc.getURL().startsWith('file:'))) e.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}

/** @param {string} input */
async function navigate(input) {
  const r = normalizeUrl(input);
  if ('error' in r) {
    setStatus(r.error, 'error');
    return { ok: false };
  }
  const wc = /** @type {FrameT} */ (frame).wc;
  wc.loadURL(r.url).catch(() => {}); // 失敗は did-fail-load で知らせる
  return { ok: true };
}

// ---------- 撮影 ----------

/**
 * @param {'save' | 'copy'} mode
 * @returns {Promise<CaptureResponse>}
 */
async function doCapture(mode) {
  if (!frame) return { ok: false, message: '準備中です' };
  if (capturing) return { ok: false, message: '撮影中です' };
  if (recorder?.active) return { ok: false, message: '録画中は静止画を撮れません。録画を止めてください' };
  capturing = true;
  scheduleState();
  setStatus('撮影中…');
  try {
    const s = store.data;
    const r = await captureStill(frame, {
      width: s.width,
      height: s.height,
      scale: s.scale,
      format: s.format,
      quality: s.quality,
      lossless: s.webpLossless,
      encode: mode === 'save',
    });
    const parts = [];
    /** @type {string | undefined} */
    let file;
    if (mode === 'save') {
      const name = renderName(s.nameTemplate, {
        host: hostFromUrl(frame.wc.getURL()),
        ...stamp(),
        width: s.width,
        height: s.height,
        scale: s.scale,
        title: frame.wc.getTitle(),
      });
      file = await writeUnique(effectiveOutputDir(), name, r.ext, r.buffer);
      parts.push(`保存: ${path.basename(file)}（${r.width}×${r.height}px, ${formatBytes(r.buffer.length)}）`);
    }
    if (mode === 'copy' || s.copyToClipboard) {
      await copyPng(r.png);
      parts.push(`クリップボードにコピー（${r.width}×${r.height}px）`);
    }
    const message = parts.join(' ／ ');
    setStatus(message, 'ok');
    return { ok: true, message, file };
  } catch (e) {
    const message = `撮影に失敗: ${e instanceof Error ? e.message : String(e)}`;
    setStatus(message, 'error');
    return { ok: false, message };
  } finally {
    capturing = false;
    scheduleState();
  }
}

// ---------- 録画 ----------

function stopRecTimer() {
  clearInterval(recTimer);
  recTimer = undefined;
}

/** 録画が終わったときの表示（利用者の操作でも、自動停止やエラーでも） @param {import('./record').RecordResult} r */
function reportRecordEnd(r) {
  stopRecTimer();
  const info = recInfo;
  recInfo = null;
  recorder = null;
  if (r.ok && r.file) {
    const note = r.reason === 'max' ? '（最大時間に達したので自動で止めました）' : '';
    const sound = r.audio ? ', 音声あり' : '';
    const warn = r.warning ? ` ⚠ ${r.warning}` : '';
    setStatus(
      `保存: ${path.basename(r.file)}（${info?.width}×${info?.height}px, ${info?.fps}fps, ${(r.seconds ?? 0).toFixed(1)}秒${sound}, ${formatBytes(r.bytes ?? 0)}）${note}${warn}`,
      r.warning ? 'error' : 'ok',
    );
  } else {
    setStatus(`録画に失敗: ${r.message}`, 'error');
  }
  scheduleState();
}

async function startRecording() {
  if (!frame) return { ok: false, message: '準備中です' };
  if (capturing || recorder?.active) return { ok: false, message: '撮影・録画中です' };
  const s = store.data;
  const ff = resolveFfmpeg(s.ffmpegPath);
  if ('error' in ff) {
    setStatus(ff.error, 'error');
    return { ok: false, message: ff.error };
  }
  const name = renderName(s.nameTemplate, {
    host: hostFromUrl(frame.wc.getURL()),
    ...stamp(),
    width: s.width,
    height: s.height,
    scale: 1, // 動画は等倍だけ
    title: frame.wc.getTitle(),
  });
  const rec = new Recorder(frame);
  try {
    const outFile = await uniquePath(effectiveOutputDir(), name, 'mp4');
    setStatus('録画を始めています…');
    recorder = rec;
    recInfo = { fps: s.videoFps, width: s.width, height: s.height };
    recWithAudio = s.videoAudio;
    scheduleState();
    await rec.start({
      ffmpegPath: ff.path,
      outFile,
      width: s.width,
      height: s.height,
      fps: s.videoFps,
      quality: s.videoQuality,
      maxSeconds: s.videoMaxSec,
      audio: s.videoAudio ? new PageAudio(() => (win && !win.isDestroyed() ? win.webContents : null)) : null,
      onEnd: reportRecordEnd,
    });
  } catch (e) {
    recorder = null;
    recInfo = null;
    const message = `録画を始められません: ${e instanceof Error ? e.message : String(e)}`;
    setStatus(message, 'error');
    scheduleState();
    return { ok: false, message };
  }
  const started = Date.now();
  stopRecTimer();
  recTimer = setInterval(() => {
    const left = Math.max(0, store.data.videoMaxSec * 1000 - (Date.now() - started));
    setStatus(`● 録画中${recWithAudio ? '（音声あり）' : ''} ${formatDuration(Date.now() - started)}（あと ${formatDuration(left)}で自動停止）`, 'rec');
  }, 500);
  setStatus('● 録画中 00:00', 'rec');
  scheduleState();
  return { ok: true, message: '録画を始めました' };
}

async function stopRecording() {
  const rec = recorder;
  if (!rec?.active) return { ok: false, message: '録画していません' };
  setStatus('録画を終えています…（エンコードの仕上げ中）');
  const r = await rec.stop();
  reportRecordEnd(r);
  return { ok: r.ok, message: r.message, file: r.file };
}

function toggleRecording() {
  return recorder?.active ? stopRecording() : startRecording();
}

/** 動画の設定メニュー（フレームレート・画質・最大時間）。ネイティブのメニューなので、枠の裏に隠れない */
function showVideoMenu() {
  if (!win) return;
  const s = store.data;
  const ff = resolveFfmpeg(s.ffmpegPath);
  const set = (/** @type {Record<string, unknown>} */ patch) => () => {
    store.update(patchSettings(store.data, patch));
    scheduleState();
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const t = [
    {
      label: 'フレームレート',
      submenu: VIDEO.fpsChoices.map((n) => ({ label: `${n} fps`, type: 'radio', checked: s.videoFps === n, click: set({ videoFps: n }) })),
    },
    {
      label: '画質',
      submenu: Object.entries(VIDEO.qualities).map(([key, q]) => ({
        label: q.label,
        type: 'radio',
        checked: s.videoQuality === key,
        click: set({ videoQuality: key }),
      })),
    },
    {
      label: '最大録画時間',
      submenu: VIDEO.maxSecChoices.map((n) => ({
        label: n >= 60 ? `${n / 60} 分` : `${n} 秒`,
        type: 'radio',
        checked: s.videoMaxSec === n,
        click: set({ videoMaxSec: n }),
      })),
    },
    { type: 'separator' },
    {
      label: '枠の音声を録る',
      type: 'checkbox',
      checked: s.videoAudio,
      click: set({ videoAudio: !s.videoAudio }),
    },
    { label: '（枠の音だけ。他のアプリの音は入りません）', enabled: false },
    { type: 'separator' },
    { label: '動画は等倍（1x）で録画します', enabled: false },
    {
      label: 'error' in ff ? `ffmpeg: ${esc(truncate(ff.error, 60))}` : `ffmpeg: ${ff.source === 'bundled' ? '同梱' : ff.source === 'system' ? 'システム' : '指定'}`,
      enabled: false,
    },
  ];
  Menu.buildFromTemplate(t).popup({ window: win });
}

async function openOutputDir() {
  const dir = effectiveOutputDir();
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    /* 開く側でエラーになる */
  }
  const err = await shell.openPath(dir);
  if (err) setStatus(`フォルダを開けません: ${err}`, 'error');
}

async function chooseOutputDir() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: '保存先フォルダ',
    defaultPath: effectiveOutputDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  store.update({ outputDir: r.filePaths[0] });
  scheduleState();
}

// ---------- ブックマーク・履歴 ----------

function toggleBookmark() {
  const wc = /** @type {FrameT} */ (frame).wc;
  const url = wc.getURL();
  if (!/^https?:\/\//i.test(url)) {
    setStatus('http/https のページだけブックマークできます', 'error');
    return;
  }
  const before = store.data.bookmarks.length;
  const bookmarks = lists.toggleBookmark(store.data.bookmarks, url, wc.getTitle());
  store.update({ bookmarks });
  setStatus(bookmarks.length > before ? 'ブックマークに追加しました' : 'ブックマークを外しました');
  scheduleState();
}

function showBookmarksMenu() {
  if (!win || !frame) return;
  const s = store.data;
  const url = frame.wc.getURL();
  const bookmarkable = /^https?:\/\//i.test(url);
  const go = (/** @type {string} */ u) => () => void navigate(u);
  const label = (/** @type {{ title: string, url: string }} */ b, n = 52) => esc(truncate(b.title || b.url, n));

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const t = [
    {
      label: lists.isBookmarked(s.bookmarks, url) ? '★ ブックマークを外す' : '☆ このページをブックマーク',
      enabled: bookmarkable,
      click: toggleBookmark,
    },
    { type: 'separator' },
  ];
  if (s.bookmarks.length) {
    for (const b of s.bookmarks) t.push({ label: label(b), toolTip: b.url, click: go(b.url) });
    t.push({ type: 'separator' });
    t.push({
      label: '並べ替え・削除',
      submenu: s.bookmarks.map((b, i) => ({
        label: label(b, 40),
        submenu: [
          {
            label: '上へ',
            enabled: i > 0,
            click: () => {
              store.update({ bookmarks: lists.moveBookmark(store.data.bookmarks, i, -1) });
            },
          },
          {
            label: '下へ',
            enabled: i < s.bookmarks.length - 1,
            click: () => {
              store.update({ bookmarks: lists.moveBookmark(store.data.bookmarks, i, 1) });
            },
          },
          {
            label: '削除',
            click: () => {
              store.update({ bookmarks: lists.removeBookmarkAt(store.data.bookmarks, i) });
              scheduleState();
            },
          },
        ],
      })),
    });
  } else {
    t.push({ label: '（ブックマークはまだありません）', enabled: false });
  }
  t.push({ type: 'separator' });
  t.push({
    label: '最近開いた URL',
    enabled: s.recent.length > 0,
    submenu: [
      ...s.recent.map((u) => ({ label: esc(truncate(u, 64)), click: go(u) })),
      { type: 'separator' },
      {
        label: '履歴を消去',
        click: () => {
          store.update({ recent: [] });
        },
      },
    ],
  });
  Menu.buildFromTemplate(t).popup({ window: win });
}

// ---------- IPC（ツールバー UI からだけ受け付ける）----------

/**
 * @param {string} channel
 * @param {(...args: any[]) => any} fn
 */
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) throw new Error('forbidden');
    return fn(...args);
  });
}

function registerIpc() {
  handle('state:get', () => buildState());
  handle('nav:go', (input) => navigate(String(input)));
  handle('nav:action', (action) => {
    const wc = /** @type {FrameT} */ (frame).wc;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  });
  handle('settings:patch', (patch) => {
    if (recorder?.active && patch && typeof patch === 'object') {
      // 録画中にサイズ・倍率を変えると録画が壊れるので、受け付けない
      const rest = { ...patch };
      if ('width' in rest || 'height' in rest || 'scale' in rest) setStatus('録画中は枠のサイズ・倍率を変えられません', 'error');
      delete rest.width;
      delete rest.height;
      delete rest.scale;
      patch = rest;
    }
    const next = patchSettings(store.data, patch);
    store.update(next);
    const f = /** @type {FrameT} */ (frame);
    if (f.width !== next.width || f.height !== next.height) f.setSize(next.width, next.height);
    relayout();
  });
  handle('capture:still', (mode) => doCapture(mode === 'copy' ? 'copy' : 'save'));
  handle('record:toggle', toggleRecording);
  handle('video:menu', showVideoMenu);
  handle('output:choose', chooseOutputDir);
  handle('output:open', openOutputDir);
  handle('bookmarks:toggle', toggleBookmark);
  handle('bookmarks:menu', showBookmarksMenu);
  handle('presets:add', (name) => {
    const s = store.data;
    const presets = lists.addPreset(s.presets, String(name), s.width, s.height);
    if (presets.length === s.presets.length && !s.presets.some((p) => p.name === String(name).trim())) {
      setStatus(`プリセットは ${LIMITS.maxPresets} 件までです`, 'error');
      return;
    }
    store.update({ presets });
    setStatus(`プリセット「${String(name).trim()}」を登録しました`, 'ok');
    scheduleState();
  });
  handle('presets:remove', (name) => {
    store.update({ presets: lists.removePreset(store.data.presets, String(name)) });
    scheduleState();
  });
}

// ---------- メニュー（ショートカット）----------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const wc = () => /** @type {FrameT} */ (frame).wc;
  const focusUrl = () => {
    win?.webContents.focus();
    send('focus-url');
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? /** @type {Electron.MenuItemConstructorOptions[]} */ ([{ role: 'appMenu' }]) : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '静止画を保存', accelerator: 'CmdOrCtrl+Shift+S', click: () => void doCapture('save') },
        { label: 'クリップボードにコピー', accelerator: 'CmdOrCtrl+Shift+C', click: () => void doCapture('copy') },
        { label: '録画の開始 / 停止', accelerator: 'CmdOrCtrl+Shift+R', click: () => void toggleRecording() },
        { label: '保存先を開く', click: () => void openOutputDir() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '終了' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '表示',
      submenu: [
        { label: 'URL バーへ移動', accelerator: 'CmdOrCtrl+L', click: focusUrl },
        { label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => wc().reload() },
        { label: '再読み込み', accelerator: 'F5', visible: false, click: () => wc().reload() },
        { label: '戻る', accelerator: 'Alt+Left', click: () => wc().navigationHistory.canGoBack() && wc().navigationHistory.goBack() },
        { label: '進む', accelerator: 'Alt+Right', click: () => wc().navigationHistory.canGoForward() && wc().navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'ページの開発者ツール', accelerator: 'F12', click: () => wc().openDevTools({ mode: 'detach' }) },
        { label: 'Frameshot の開発者ツール', accelerator: 'CmdOrCtrl+Shift+F12', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- ウィンドウ ----------

/**
 * 開発中（npm start）に使うウィンドウのアイコン。配布版は exe / app に埋め込まれたアイコンが使われる
 * （build/ は配布物に入らないので、ここでは見つからず何もしない）
 */
const devIcon = (() => {
  const p = path.join(__dirname, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return fs.existsSync(p) ? p : undefined;
})();

function createWindow() {
  const w = store.data.window;
  /** @type {Electron.BrowserWindowConstructorOptions} */
  const opts = {
    width: w.width,
    height: w.height,
    minWidth: 1200,
    minHeight: 560,
    backgroundColor: '#0b0710',
    title: 'Frameshot',
    ...(devIcon ? { icon: devIcon } : {}),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (w.x !== undefined && w.y !== undefined && onScreen({ x: w.x, y: w.y, width: w.width, height: w.height })) {
    opts.x = w.x;
    opts.y = w.y;
  }
  win = new BrowserWindow(opts);

  // ツールバー UI は自分のページから動かさない
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  frame = new Frame(win, { partition: PARTITION });
  frame.setSize(store.data.width, store.data.height);
  wirePageEvents();

  /** @type {NodeJS.Timeout | undefined} */
  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      store.update({ window: win.getNormalBounds() });
    }, 500);
  };
  win.on('resize', () => {
    relayout();
    saveBounds();
  });
  win.on('move', saveBounds);
  win.once('ready-to-show', () => win?.show());
  // 録画中に閉じられたら、録画を仕上げてから閉じる（書きかけの動画を残さない）
  let closingAfterRecord = false;
  win.on('close', (e) => {
    if (!recorder?.active || closingAfterRecord) return;
    e.preventDefault();
    void stopRecording().finally(() => {
      closingAfterRecord = true;
      win?.close();
    });
  });
  win.on('closed', () => {
    frame?.destroy();
    frame = null;
    win = null;
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html')).then(relayout);

  const url = store.data.url;
  const first = /^https?:\/\//i.test(url) ? frame.wc.loadURL(url) : frame.wc.loadFile(START_PAGE);
  first.catch(() => {});
}

// ---------- 起動 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', () => store?.flush());
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fixtan.frameshot');
    store = new Store(path.join(app.getPath('userData'), 'settings.json'));
    hardenSession();
    installDisplayMediaHandler(
      session.defaultSession,
      () => (win && !win.isDestroyed() ? win.webContents : null),
      () => (frame && !frame.wc.isDestroyed() ? frame.wc : null),
    );
    registerIpc();
    createWindow();
    buildMenu();
  });
}

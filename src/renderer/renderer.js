// @ts-check
'use strict';

// ツールバー UI。状態はメインプロセスが持っていて、ここは表示と操作の送信だけ行う

/** @typedef {import('../shared/types').FrameshotState} State */

const api = window.frameshot;

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return /** @type {T} */ (el);
}

const el = {
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  url: /** @type {HTMLInputElement} */ ($('url')),
  star: $('star'),
  books: $('books'),
  w: /** @type {HTMLInputElement} */ ($('w')),
  h: /** @type {HTMLInputElement} */ ($('h')),
  swap: $('swap'),
  presetBox: $('presetBox'),
  preset: /** @type {HTMLSelectElement} */ ($('preset')),
  presetAdd: $('presetAdd'),
  presetDel: /** @type {HTMLButtonElement} */ ($('presetDel')),
  presetNameBox: $('presetNameBox'),
  presetName: /** @type {HTMLInputElement} */ ($('presetName')),
  presetOk: $('presetOk'),
  presetCancel: $('presetCancel'),
  scale: /** @type {HTMLSelectElement} */ ($('scale')),
  format: /** @type {HTMLSelectElement} */ ($('format')),
  qualityBox: $('qualityBox'),
  quality: /** @type {HTMLInputElement} */ ($('quality')),
  losslessBox: $('losslessBox'),
  lossless: /** @type {HTMLInputElement} */ ($('lossless')),
  copyToo: /** @type {HTMLInputElement} */ ($('copyToo')),
  rec: /** @type {HTMLButtonElement} */ ($('rec')),
  recOpt: $('recOpt'),
  copy: /** @type {HTMLButtonElement} */ ($('copy')),
  shoot: /** @type {HTMLButtonElement} */ ($('shoot')),
  outline: $('outline'),
  status: $('status'),
  info: $('info'),
  dir: $('dir'),
  openDir: $('openDir'),
  chooseDir: $('chooseDir'),
};

/** @type {State | null} */
let state = null;
/** プリセットの名前入力中は、状態が届いても入力欄を上書きしない */
let namingPreset = false;

// ---------- 表示 ----------

/** 長いパスは先頭を省略して末尾（フォルダ名）を見せる @param {string} p @param {number} max */
function tailEllipsis(p, max) {
  return p.length <= max ? p : '…' + p.slice(p.length - (max - 1));
}

/** @param {HTMLInputElement | HTMLSelectElement} input @param {string} value */
function setValue(input, value) {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

/** プリセットの選択肢を作り直す（名前はユーザーの入力なので textContent で入れる） @param {State} s */
function renderPresets(s) {
  const sel = el.preset;
  sel.textContent = '';
  const add = (/** @type {Node} */ parent, /** @type {string} */ value, /** @type {string} */ text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    parent.appendChild(o);
  };
  add(sel, '', 'プリセット…');
  const builtin = document.createElement('optgroup');
  builtin.label = '標準';
  s.builtinPresets.forEach((p, i) => add(builtin, `b:${i}`, p.name));
  sel.appendChild(builtin);
  if (s.presets.length) {
    const custom = document.createElement('optgroup');
    custom.label = '自分用';
    s.presets.forEach((p, i) => add(custom, `c:${i}`, `${p.name}  ${p.w}×${p.h}`));
    sel.appendChild(custom);
  }
  // 今のサイズに合うものを選んでおく（自分用を優先）
  const ci = s.presets.findIndex((p) => p.w === s.width && p.h === s.height);
  const bi = s.builtinPresets.findIndex((p) => p.w === s.width && p.h === s.height);
  sel.value = ci >= 0 ? `c:${ci}` : bi >= 0 ? `b:${bi}` : '';
  el.presetDel.disabled = ci < 0 || sel.value !== `c:${ci}`;
}

/** @param {State} s */
function render(s) {
  state = s;

  el.back.toggleAttribute('disabled', !s.canGoBack);
  el.forward.toggleAttribute('disabled', !s.canGoForward);
  el.reload.textContent = s.loading ? '✕' : '⟳';
  el.reload.title = s.loading ? '読み込みを止める' : '再読み込み (F5)';
  if (document.activeElement !== el.url) el.url.value = s.url;
  el.star.textContent = s.bookmarked ? '★' : '☆';
  el.star.classList.toggle('on', s.bookmarked);
  el.star.toggleAttribute('disabled', !s.bookmarkable);
  el.star.title = s.bookmarked ? 'ブックマークを外す' : 'このページをブックマーク';

  setValue(el.w, String(s.width));
  setValue(el.h, String(s.height));
  setValue(el.scale, String(s.scale));
  setValue(el.format, s.format);
  setValue(el.quality, String(s.quality));
  el.lossless.checked = s.webpLossless;
  el.copyToo.checked = s.copyToClipboard;
  el.qualityBox.hidden = s.format === 'png' || (s.format === 'webp' && s.webpLossless);
  el.losslessBox.hidden = s.format !== 'webp';
  if (!namingPreset) renderPresets(s);

  el.shoot.disabled = s.busy;
  el.copy.disabled = s.busy;
  // 録画中は止めるボタンだけ生かす。枠のサイズ・倍率は録画中に変えられない
  el.rec.disabled = s.busy && !s.recording;
  el.rec.textContent = s.recording ? '⏹' : '⏺';
  el.rec.classList.toggle('recording', s.recording);
  el.rec.title = s.recording ? '録画を止めて保存 (Ctrl+Shift+R)' : '録画を開始 (Ctrl+Shift+R)';
  el.recOpt.toggleAttribute('disabled', s.recording);
  for (const input of [el.w, el.h, el.scale, el.preset, el.swap, el.presetAdd]) input.toggleAttribute('disabled', s.recording);
  el.outline.classList.toggle('recording', s.recording);

  // 枠の輪郭（枠の実物はこの上に重なる）
  const r = s.rect;
  Object.assign(el.outline.style, {
    left: `${r.x - 1}px`,
    top: `${r.y - 1}px`,
    width: `${r.width + 2}px`,
    height: `${r.height + 2}px`,
  });
  el.outline.hidden = false;

  if (s.recording) {
    const cropped = r.width < s.width || r.height < s.height;
    el.info.textContent = `録画 ${s.width}×${s.height}px ${s.videoFps}fps${s.videoAudio ? ' 音声あり' : ''}${cropped ? '／画面には左上だけ表示（録画は全体）' : ''}`;
  } else {
    const zoom = s.fit < 0.995 ? `／表示 ${Math.round(s.fit * 100)}%（撮影は実寸）` : '';
    el.info.textContent = `撮影 ${s.outWidth}×${s.outHeight}px（${s.width}×${s.height} ×${s.scale}）${zoom}`;
  }
  el.dir.textContent = tailEllipsis(s.outputDir, 44);
  el.dir.title = s.outputDir;
}

/** @param {string} message @param {import('../shared/types').StatusKind} kind */
function setStatus(message, kind) {
  el.status.textContent = message;
  el.status.title = message;
  el.status.className = kind === 'info' ? '' : kind;
}

// ---------- 操作 ----------

el.back.addEventListener('click', () => void api.nav('back'));
el.forward.addEventListener('click', () => void api.nav('forward'));
el.reload.addEventListener('click', () => void api.nav(state?.loading ? 'stop' : 'reload'));

el.url.addEventListener('focus', () => el.url.select());
el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    void api.navigate(el.url.value);
    el.url.blur();
  } else if (e.key === 'Escape' && state) {
    el.url.value = state.url;
    el.url.blur();
  }
});
el.star.addEventListener('click', () => void api.toggleBookmark());
el.books.addEventListener('click', () => void api.showBookmarks());

/** 数値欄は Enter かフォーカスが外れたときに反映する（入力のたびに反映すると、途中の値で枠が暴れる） */
function commitSize() {
  void api.patch({ width: Number(el.w.value), height: Number(el.h.value) });
}
for (const input of [el.w, el.h]) {
  input.addEventListener('change', commitSize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitSize();
      input.blur();
    }
  });
}
el.swap.addEventListener('click', () => {
  if (state) void api.patch({ width: state.height, height: state.width });
});

el.preset.addEventListener('change', () => {
  if (!state) return;
  const [kind, idx] = el.preset.value.split(':');
  const list = kind === 'b' ? state.builtinPresets : kind === 'c' ? state.presets : [];
  const p = list[Number(idx)];
  if (p) void api.patch({ width: p.w, height: p.h });
});
el.presetDel.addEventListener('click', () => {
  if (!state) return;
  const [kind, idx] = el.preset.value.split(':');
  const p = kind === 'c' ? state.presets[Number(idx)] : undefined;
  if (p) void api.removePreset(p.name);
});

function openPresetName() {
  namingPreset = true;
  el.presetBox.hidden = true;
  el.presetNameBox.hidden = false;
  el.presetName.value = state ? `${state.width}×${state.height}` : '';
  el.presetName.focus();
  el.presetName.select();
}
function closePresetName() {
  namingPreset = false;
  el.presetNameBox.hidden = true;
  el.presetBox.hidden = false;
  if (state) renderPresets(state);
}
function commitPresetName() {
  const name = el.presetName.value.trim();
  if (name) void api.addPreset(name);
  closePresetName();
}
el.presetAdd.addEventListener('click', openPresetName);
el.presetOk.addEventListener('click', commitPresetName);
el.presetCancel.addEventListener('click', closePresetName);
el.presetName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commitPresetName();
  else if (e.key === 'Escape') closePresetName();
});

el.scale.addEventListener('change', () => void api.patch({ scale: Number(el.scale.value) }));
el.format.addEventListener('change', () => void api.patch({ format: /** @type {'png' | 'jpg' | 'webp'} */ (el.format.value) }));
el.quality.addEventListener('change', () => void api.patch({ quality: Number(el.quality.value) }));
el.lossless.addEventListener('change', () => void api.patch({ webpLossless: el.lossless.checked }));
el.copyToo.addEventListener('change', () => void api.patch({ copyToClipboard: el.copyToo.checked }));

el.shoot.addEventListener('click', () => void api.captureStill('save'));
el.copy.addEventListener('click', () => void api.captureStill('copy'));
el.rec.addEventListener('click', () => void api.toggleRecord());
el.recOpt.addEventListener('click', () => void api.showVideoMenu());
el.openDir.addEventListener('click', () => void api.openOutputDir());
el.chooseDir.addEventListener('click', () => void api.chooseOutputDir());

// ---------- メインプロセスからの通知 ----------

api.onState(render);
api.onStatus((s) => setStatus(s.message, s.kind));
api.onFocusUrl(() => {
  el.url.focus();
  el.url.select();
});

void api.getState().then(render);

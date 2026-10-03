// @ts-check
'use strict';

// 実際の Chromium と同梱の ffmpeg で、画面に入らない縦長の枠が欠けずに録れることを確かめる自己検査。
//   npm run test:record
// 画面のない環境では:
//   xvfb-run -a -s "-screen 0 1280x800x24" npx electron --no-sandbox test/record.selftest.js
// 録った動画は test/out/ に出る（目で確かめる用）。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const { Frame } = require('../src/main/frame');
const { Recorder } = require('../src/main/record');
const { resolveFfmpeg } = require('../src/main/ffmpeg');
const { PageAudio, installDisplayMediaHandler } = require('../src/main/audio');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const OUT = path.join(__dirname, 'out');
const ANIM = path.join(__dirname, 'fixtures', 'anim.html');
const STATIC = path.join(__dirname, 'fixtures', 'tall.html');
const TONE = path.join(__dirname, 'fixtures', 'tone.html');
const UI = path.join(__dirname, 'fixtures', 'ui.html');
const CHROME = { top: 96, bottom: 30, margin: 14 };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const found = resolveFfmpeg('');
if ('error' in found) throw new Error(found.error);
const ff = { path: found.path, source: found.source };
console.log(`ffmpeg: ${ff.source} ${ff.path}`);

/** 動画の長さ・フレーム数・大きさを ffmpeg で読む @param {string} file */
function probe(file) {
  const r = spawnSync(ff.path, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
  const err = r.stderr;
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
  const size = /Video: h264[^\n]*?, (\d+)x(\d+)/.exec(err);
  const frames = [...err.matchAll(/frame=\s*(\d+)/g)].pop();
  return {
    seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    frames: frames ? Number(frames[1]) : 0,
  };
}

/** 音声ストリームの有無と、平均音量（dB。無音なら約 -91）を読む @param {string} file */
function probeAudio(file) {
  const r = spawnSync(ff.path, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const err = r.stderr;
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(err);
  const dur = /time=(\d+):(\d+):(\d+\.\d+)/g;
  const last = [...err.matchAll(dur)].pop();
  return {
    has: /Audio: aac/.test(err),
    meanDb: mean ? Number(mean[1]) : NaN,
    seconds: last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : NaN,
  };
}

/** 左右それぞれの平均音量（dB）。無音なら約 -91 @param {string} file */
function channelDb(file) {
  /** @param {number} c */
  const one = (c) => {
    const r = spawnSync(ff.path, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', `pan=mono|c0=c${c},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
    return m ? Number(m[1]) : NaN;
  };
  return { left: one(0), right: one(1) };
}

/** @param {string} file */
const a_has = (file) => probeAudio(file).has;

/** 動画の t 秒の 1 コマを PNG で取り出す @param {string} file @param {number} t */
async function frameAt(file, t) {
  const png = `${file}.${t}.png`;
  spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  fs.rmSync(png, { force: true });
  return { data, width: info.width, height: info.height };
}
/** @param {{data: Buffer, width: number}} img @param {number} x @param {number} y */
const px = (img, x, y) => [0, 1, 2].map((k) => img.data[(y * img.width + x) * 4 + k]);
/** @param {number[]} c @param {number[]} want */
const near = (c, want, tol = 70) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
/** @param {{data: Buffer, width: number, height: number}} img */
function edges(img) {
  const { width: w, height: h } = img;
  return {
    top: near(px(img, w >> 1, 4), [255, 0, 0]),
    bottom: near(px(img, w >> 1, h - 5), [0, 0, 255]),
    right: near(px(img, w - 5, h >> 1), [0, 170, 0]),
    left: near(px(img, 4, h >> 1), [255, 170, 0]),
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, useContentSize: true });
  const frame = new Frame(win, { partition: 'frameshot-record-selftest' });
  const [cw, ch] = win.getContentSize();
  const availH = ch - CHROME.top - CHROME.bottom - CHROME.margin * 2;

  /**
   * @param {string} name
   * @param {Partial<import('../src/main/record').RecordOptions>} over
   */
  const mk = (name, over = {}) => {
    const outFile = path.join(OUT, `rec-${name}.mp4`);
    for (const f of [outFile, `${outFile}.part`]) fs.rmSync(f, { force: true });
    /** @type {import('../src/main/record').RecordResult[]} */
    const ended = [];
    const opts = {
      ffmpegPath: ff.path, outFile, width: 880, height: 1320, fps: 15, quality: /** @type {const} */ ('light'),
      maxSeconds: 60, onEnd: (/** @type {any} */ r) => ended.push(r), ...over,
    };
    return { opts, outFile, ended };
  };
  /** @param {number} w @param {number} h @param {string} page */
  async function open(w, h, page) {
    frame.setSize(w, h);
    await frame.wc.loadFile(page);
    frame.layout(cw, ch, CHROME);
    await sleep(400);
  }

  // ---- 1. 画面に入らない縦長（880x1320、画面の高さは 800）を 3 秒録る ----
  {
    await open(880, 1320, ANIM);
    check('前提: 枠は画面に入らない', 1320 > availH, `枠 1320 / 表示領域 ${availH}`);
    const { opts, outFile, ended } = mk('anim');
    const rec = new Recorder(frame);
    await rec.start(opts);
    check('録画中: 枠は撮影サイズ・等倍のまま、見える範囲だけ切り抜いて表示', frame.recording && frame.fit === 1 && frame.rect.height < 1320, JSON.stringify(frame.rect));
    const [vw, vh, dpr] = await frame.wc.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio]');
    check('録画中: ページのビューポート = 撮影サイズ', vw === 880 && vh === 1320 && dpr === 1, `${vw}x${vh}@${dpr}`);
    await sleep(3000);
    const r = await rec.stop();
    check('停止して保存できる', r.ok && !!r.file && fs.existsSync(outFile), r.message);
    check('onEnd は手動停止では呼ばれない', ended.length === 0);
    check('.part が残らない', !fs.existsSync(`${outFile}.part`));
    const p = probe(outFile);
    check('動画の大きさ = 880x1320', p.width === 880 && p.height === 1320, `${p.width}x${p.height}`);
    check('動画の長さ ≈ 録画時間（3 秒）', Math.abs(p.seconds - 3) < 0.45, `${p.seconds}s`);
    check('フレーム数 ≈ 15fps × 3 秒', Math.abs(p.frames - 45) <= 6, `${p.frames}枚`);
    const f0 = await frameAt(outFile, p.seconds - 0.2);
    const e = edges(f0);
    check('動画の最後のコマに四辺の色帯が全部写っている（はみ出し部分も録れている）', e.top && e.bottom && e.left && e.right, JSON.stringify(e));
    const a = await frameAt(outFile, 0.5);
    const b = await frameAt(outFile, 2.0);
    check('動画の中身が動いている', Buffer.compare(a.data, b.data) !== 0);
    check('録画後: 縮小プレビューに戻り、撮影できる状態', !frame.recording && !frame.busy && frame.fit < 1, `fit=${frame.fit.toFixed(3)}`);
    await sleep(300);
    const [vw2, , dpr2] = await frame.wc.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio]');
    check('録画後: ページのビューポートはプレビュー用（撮影サイズ・等倍）', vw2 === 880 && dpr2 === 1);
  }

  // ---- 2. 静止ページ + 奇数サイズ ----
  {
    await open(881, 1321, STATIC);
    const { opts, outFile } = mk('static-odd', { width: 881, height: 1321 });
    const rec = new Recorder(frame);
    await rec.start(opts);
    await sleep(2500);
    const r = await rec.stop();
    const p = probe(outFile);
    check('静止ページ: 保存できる', r.ok, r.message);
    check('奇数サイズ 881x1321 → 880x1320 に切り詰め', p.width === 880 && p.height === 1320, `${p.width}x${p.height}`);
    check('静止ページでも長さが録画時間どおり（2.5 秒）', Math.abs(p.seconds - 2.5) < 0.45, `${p.seconds}s`);
    const e = edges(await frameAt(outFile, 2.0));
    check('静止ページの四辺', e.top && e.bottom && e.left && e.right, JSON.stringify(e));
  }

  // ---- 3. 録画してすぐ止める ----
  {
    await open(880, 1320, ANIM);
    const { opts, outFile } = mk('instant');
    const rec = new Recorder(frame);
    await rec.start(opts);
    const r = await rec.stop();
    const p = probe(outFile);
    check('すぐ止めても、再生できる動画になる（1 枚以上）', r.ok && p.frames >= 1, `${p.frames}枚 ${r.message}`);
  }

  // ---- 4. 最大時間で自動停止 ----
  {
    const { opts, outFile, ended } = mk('max', { maxSeconds: 2 });
    const rec = new Recorder(frame);
    await rec.start(opts);
    await sleep(3500);
    check('最大時間に達すると自動で止まり、onEnd(max) が呼ばれる', ended.length === 1 && ended[0].ok && ended[0].reason === 'max', JSON.stringify(ended.map((x) => [x.ok, x.reason, x.message])));
    check('自動停止のあと録画中ではない', !rec.active && !frame.recording);
    const p = probe(outFile);
    check('自動停止の動画の長さ ≈ 2 秒', Math.abs(p.seconds - 2) < 0.5, `${p.seconds}s`);
  }

  // ---- 5. ffmpeg が途中で死んだ ----
  {
    const { opts, outFile, ended } = mk('killed');
    const rec = new Recorder(frame);
    await rec.start(opts);
    await sleep(800);
    /** @type {import('child_process').ChildProcess} */ (rec.ff).kill('SIGKILL');
    await sleep(1500);
    check('ffmpeg が死ぬと onEnd(error) が呼ばれ、録画は終わる', ended.length === 1 && !ended[0].ok && ended[0].reason === 'error', JSON.stringify(ended.map((x) => [x.ok, x.reason, x.message.slice(0, 80)])));
    check('書きかけのファイルは残らない', !fs.existsSync(outFile) && !fs.existsSync(`${outFile}.part`));
    check('失敗のあとも枠は元の状態に戻る', !frame.recording && !frame.busy && frame.fit < 1);
  }

  // ---- 6. ffmpeg を起動できない ----
  {
    const { opts } = mk('nofile', { ffmpegPath: path.join(OUT, 'no-such-ffmpeg') });
    const rec = new Recorder(frame);
    /** @type {string} */
    let msg = '';
    try {
      await rec.start(opts);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check('ffmpeg を起動できなければ録画は始まらず、理由が出る', msg.includes('ffmpeg') && !rec.active, msg);
    check('始まらなかったあとも枠は元の状態', !frame.recording && !frame.busy);
  }

  // ---- 7. 二重に始められない ----
  {
    const { opts } = mk('twice');
    const rec = new Recorder(frame);
    await rec.start(opts);
    /** @type {string} */
    let msg = '';
    try {
      await rec.start(opts);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check('録画中に start を重ねるとエラー', msg.includes('録画中'), msg);
    const r = await rec.stop();
    check('二重 start のあとも正常に止められる', r.ok, r.message);
  }

  // ---- 8. 音声 ----
  {
    // ツールバー役のウィンドウ（audio-capture.js を読み込む）。枠の音声だけを返すハンドラを入れる
    const ui = new BrowserWindow({ width: 400, height: 200, show: true });
    await ui.loadFile(UI);
    installDisplayMediaHandler(ui.webContents.session, () => ui.webContents, () => frame.wc);
    const tmpAudio = () => fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith(`frameshot-audio-${process.pid}-`));
    const audioFor = () => new PageAudio(() => ui.webContents);

    // 8-1. 音が鳴っている枠
    await open(880, 1320, TONE);
    await frame.wc.executeJavaScript('startTone()', true);
    await sleep(300);
    {
      const { opts, outFile, ended } = mk('audio-tone', { audio: audioFor() });
      const rec = new Recorder(frame);
      await rec.start(opts);
      await sleep(3000);
      const r = await rec.stop();
      check('音声あり: 保存できて、結果に audio=true', r.ok && r.audio === true && !r.warning, `${r.message} ${r.warning ?? ''}`);
      const p = probe(outFile);
      const a = probeAudio(outFile);
      check('音声あり: MP4 に AAC の音声が入っている', a.has);
      check('音声あり: 枠の音（440Hz）が録れている（無音ではない）', a.meanDb > -40, `${a.meanDb}dB`);
      const ch = channelDb(outFile);
      check('音声あり: ステレオのまま録れている（左だけ鳴らした音が、左だけに入る）', ch.left > -40 && ch.right < -60, `左 ${ch.left}dB / 右 ${ch.right}dB`);
      check('音声あり: 映像は 880x1320 のまま、長さ ≈ 3 秒', p.width === 880 && p.height === 1320 && Math.abs(p.seconds - 3) < 0.5, `${p.width}x${p.height} ${p.seconds}s`);
      check('音声あり: 音声の長さ ≈ 映像の長さ', Math.abs(a.seconds - p.seconds) < 0.4, `音声 ${a.seconds}s / 映像 ${p.seconds}s`);
      check('音声あり: 一時ファイルが残らない', tmpAudio().length === 0 && !fs.existsSync(`${outFile}.mux`) && !fs.existsSync(`${outFile}.part`), tmpAudio().join(','));
      check('音声あり: 録画後は枠が元の状態', !frame.recording && !frame.busy && frame.fit < 1);
    }

    // 8-2. 無音の枠で音声 ON（失敗にならず、無音のトラックが入る）
    await open(880, 1320, ANIM);
    {
      const { opts, outFile } = mk('audio-silent', { audio: audioFor() });
      const rec = new Recorder(frame);
      await rec.start(opts);
      await sleep(2000);
      const r = await rec.stop();
      const a = probeAudio(outFile);
      check('無音の枠でも保存できる（audio=true、ほぼ無音）', r.ok && r.audio === true && a.has && a.meanDb < -60, `${r.message} ${a.meanDb}dB`);
    }

    // 8-3. 音声を始められない → 映像だけ録って警告
    {
      const failing = { start: () => Promise.reject(new Error('テスト: 音声なし')), stop: () => Promise.resolve(null) };
      const { opts, outFile } = mk('audio-nostart', { audio: failing });
      const rec = new Recorder(frame);
      await rec.start(opts);
      await sleep(1500);
      const r = await rec.stop();
      const p = probe(outFile);
      check('音声を始められなくても、映像は録れて警告が出る', r.ok && !r.audio && /音声は録れませんでした/.test(r.warning ?? '') && p.frames > 0, `${r.warning}`);
    }

    // 8-4. 音声ファイルが壊れていて結合できない → 映像だけ保存して警告、一時ファイルは消す
    {
      const bad = path.join(OUT, 'bad-audio.webm');
      const fake = {
        start: () => Promise.resolve({ startedAt: Date.now() }),
        stop: async () => {
          fs.writeFileSync(bad, 'not audio');
          return { file: bad, startedAt: Date.now() };
        },
      };
      const { opts, outFile } = mk('audio-badmux', { audio: fake });
      const rec = new Recorder(frame);
      await rec.start(opts);
      await sleep(1500);
      const r = await rec.stop();
      const p = probe(outFile);
      check('音声を結合できないときは、映像だけ保存して警告が出る', r.ok && !r.audio && /結合できませんでした/.test(r.warning ?? '') && p.frames > 0 && !a_has(outFile), r.warning ?? '');
      check('結合に失敗しても、一時ファイルは残らない', !fs.existsSync(bad) && !fs.existsSync(`${outFile}.mux`) && !fs.existsSync(`${outFile}.part`));
    }

    // 8-5. 録画の途中で ffmpeg が死んだら、録音も止めて一時ファイルを残さない
    {
      await open(880, 1320, TONE);
      await frame.wc.executeJavaScript('startTone()', true);
      const au = audioFor();
      const { opts, outFile, ended } = mk('audio-killed', { audio: au });
      const rec = new Recorder(frame);
      await rec.start(opts);
      await sleep(800);
      /** @type {import('child_process').ChildProcess} */ (rec.ff).kill('SIGKILL');
      await sleep(2000);
      check('ffmpeg が死んだら録音も止まり、一時ファイルも残らない', ended.length === 1 && !ended[0].ok && !au.active && tmpAudio().length === 0 && !fs.existsSync(outFile), JSON.stringify(ended.map((x) => x.reason)));
    }
    ui.destroy();
  }

  console.log(failures ? `\n${failures} 件失敗` : '\n全部通りました');
  app.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  app.exit(2);
});

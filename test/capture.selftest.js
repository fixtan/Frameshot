// @ts-check
'use strict';

// 実際の Chromium で、縦長の静止画が欠けずに撮れることを確かめる自己検査。
//   npm run test:capture
// 画面のない環境（CI・Linux サーバー）では:
//   xvfb-run -a -s "-screen 0 1280x800x24" npx electron --no-sandbox test/capture.selftest.js
// 撮った画像は test/out/ に出る（目で確かめる用）。

const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Frame } = require('../src/main/frame');
const { captureStill } = require('../src/main/capture');
const { copyPng } = require('../src/main/clipboard');

// GPU のない環境でも描画できるようにする（検査用）
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const OUT = path.join(__dirname, 'out');
const FIXTURE = path.join(__dirname, 'fixtures', 'tall.html');
const CHROME = { top: 96, bottom: 30, margin: 14 };

let failures = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

/** @param {Buffer} buf */
async function raw(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
/** @param {{data: Buffer, width: number}} img @param {number} x @param {number} y */
const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
/** @param {number[]} c @param {number[]} want */
const near = (c, want, tol = 48) => c.every((v, i) => Math.abs(v - want[i]) <= tol);

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 170, 0];
const ORANGE = [255, 170, 0];

/**
 * 四辺の色帯が全部写っているか。w / h を渡すと、画像の左上のその範囲だけを見る
 * @param {{data: Buffer, width: number, height: number}} img
 * @param {number} [w]
 * @param {number} [h]
 */
function edgesOk(img, w = img.width, h = img.height) {
  return {
    top: near(px(img, w >> 1, 2), RED),
    bottom: near(px(img, w >> 1, h - 3), BLUE),
    right: near(px(img, w - 3, h >> 1), GREEN),
    left: near(px(img, 2, h >> 1), ORANGE),
  };
}

/** @param {InstanceType<typeof Frame>} frame */
const viewport = (frame) => frame.wc.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio]');

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { w: 880, h: 1320, scale: 1, format: /** @type {const} */ ('png'), lossless: false },
  { w: 880, h: 1320, scale: 1, format: /** @type {const} */ ('webp'), lossless: false },
  { w: 1024, h: 1536, scale: 2, format: /** @type {const} */ ('jpg'), lossless: false },
  { w: 1024, h: 1536, scale: 2, format: /** @type {const} */ ('webp'), lossless: true },
  { w: 1920, h: 1080, scale: 1, format: /** @type {const} */ ('png'), lossless: false },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await app.whenReady();

  const win = new BrowserWindow({ width: 1100, height: 800, show: true, useContentSize: true });
  const frame = new Frame(win, { partition: 'frameshot-selftest' });
  await frame.wc.loadFile(FIXTURE);

  const [cw, ch] = win.getContentSize();
  console.log(`window content ${cw}x${ch}`);

  for (const c of CASES) {
    const label = `${c.w}x${c.h} @${c.scale}x ${c.format}${c.lossless ? '(lossless)' : ''}`;
    frame.setSize(c.w, c.h);
    frame.layout(cw, ch, CHROME);
    await sleep(300);

    // 1. プレビュー: ウィンドウより大きい枠でも、ページは撮影サイズでレイアウトされている
    const [vw, vh, dpr] = await viewport(frame);
    check(`[${label}] プレビューのビューポート = 撮影サイズ`, vw === c.w && vh === c.h && dpr === 1, `${vw}x${vh}@${dpr}`);
    const shrunk = c.h > ch - CHROME.top - CHROME.bottom - CHROME.margin * 2;
    if (shrunk) check(`[${label}] 画面に入らないので縮小表示になる`, frame.fit < 1, `fit=${frame.fit.toFixed(3)}`);

    // 2. プレビューの見た目: 縮小表示でもページ全体（四辺の帯）が見えている。
    //    capturePage は撮影サイズの画像を返し、その左上の view の大きさ（frame.rect）の範囲に縮小されたページが入る
    const view = await frame.wc.capturePage();
    const viewImg = await raw(view.toPNG());
    const ve = edgesOk(viewImg, frame.rect.width, frame.rect.height);
    check(`[${label}] 縮小プレビューに四辺が全部写る`, ve.top && ve.bottom && ve.left && ve.right, JSON.stringify(ve));
    if (c.scale === 2 && c.format === 'jpg') fs.writeFileSync(path.join(OUT, 'preview-shrunk.png'), view.toPNG());

    // 3. 撮影: 出力は 撮影サイズ × 倍率。四辺が全部写っている
    const r = await captureStill(frame, { width: c.w, height: c.h, scale: c.scale, format: c.format, quality: 88, lossless: c.lossless });
    check(`[${label}] 出力サイズ = サイズ × 倍率`, r.width === c.w * c.scale && r.height === c.h * c.scale, `${r.width}x${r.height}`);
    const meta = await sharp(r.buffer).metadata();
    check(`[${label}] 保存データの形式と大きさ`, meta.format === (c.format === 'jpg' ? 'jpeg' : c.format) && meta.width === r.width && meta.height === r.height, `${meta.format} ${meta.width}x${meta.height} ${r.buffer.length}B`);
    const img = await raw(r.buffer);
    const e = edgesOk(img);
    check(`[${label}] 四辺の色帯が全部写る（下が切れない）`, e.top && e.bottom && e.left && e.right, JSON.stringify(e));
    fs.writeFileSync(path.join(OUT, `shot_${c.w}x${c.h}@${c.scale}x${c.lossless ? '_lossless' : ''}.${r.ext}`), r.buffer);

    // 4. 撮影後: プレビューの emulation に戻っている
    await sleep(150);
    const [vw2, vh2, dpr2] = await viewport(frame);
    check(`[${label}] 撮影後にプレビューへ戻る`, vw2 === c.w && vh2 === c.h && dpr2 === 1, `${vw2}x${vh2}@${dpr2}`);
  }

  // クリップボード: 書いて読み戻す（Electron 44 の非同期 API）
  frame.setSize(880, 1320);
  frame.layout(cw, ch, CHROME);
  await sleep(300);
  const clip = await captureStill(frame, { width: 880, height: 1320, scale: 1, format: 'png', quality: 88, lossless: false, encode: false });
  await copyPng(clip.png);
  const items = await clipboard.read();
  const imgItem = items.find((i) => i.types.includes('image/png'));
  const blob = imgItem ? await imgItem.getType('image/png') : null;
  const back = blob ? Buffer.from(await blob.arrayBuffer()) : null;
  const backMeta = back ? await sharp(back).metadata() : null;
  check('クリップボードに PNG 画像が入る（読み戻して大きさが一致）', !!backMeta && backMeta.width === clip.width && backMeta.height === clip.height, backMeta ? `${backMeta.width}x${backMeta.height}` : `types=${items.flatMap((i) => i.types).join(',')}`);

  // 出力が大きすぎるときは、撮らずに理由つきで失敗する
  frame.setSize(8200, 8200);
  let msg = '';
  try {
    await captureStill(frame, { width: 8200, height: 8200, scale: 2, format: 'png', quality: 88, lossless: false });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check('上限を超える出力は理由つきで拒否', /大きすぎ/.test(msg), msg);

  frame.destroy();
  win.destroy();
}

const timer = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(2);
}, 180000);

main()
  .catch((e) => {
    console.error('ERROR', e);
    failures++;
  })
  .finally(() => {
    clearTimeout(timer);
    console.log(failures ? `\n${failures} 件失敗` : '\nすべて成功');
    app.exit(failures ? 1 : 0);
  });

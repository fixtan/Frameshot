// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { webContents } = require('electron');

/**
 * 枠のページの音声だけを録る。
 *
 * ツールバー UI（audio-capture.js）が getDisplayMedia で枠の webContents の音声を受け、MediaRecorder で録る。
 * システム全体の音ではないので、他のアプリの音や通知音は入らない（Windows の loopback とは違う）。
 * getDisplayMedia はユーザー操作が要るので、executeJavaScript の userGesture を true にして呼ぶ。
 */

/**
 * ツールバーからの getDisplayMedia に、枠の音声を返すようにする
 * @param {import('electron').Session} ses ツールバーの session
 * @param {() => import('electron').WebContents | null} getToolbar
 * @param {() => import('electron').WebContents | null} getPage 枠の webContents
 */
function installDisplayMediaHandler(ses, getToolbar, getPage) {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    try {
      const toolbar = getToolbar();
      const page = getPage();
      const from = request.frame ? webContents.fromFrame(request.frame) : null;
      // ツールバー以外からの要求（外部サイトなど）には、何も渡さない
      if (!toolbar || !page || page.isDestroyed() || from !== toolbar) {
        callback({});
        return;
      }
      // 録音中も、枠の音はそのまま聞こえるようにする（enableLocalEcho）
      callback({ video: page.mainFrame, audio: page.mainFrame, enableLocalEcho: true });
    } catch {
      callback({});
    }
  });
}

class PageAudio {
  /** @param {() => import('electron').WebContents | null} getToolbar */
  constructor(getToolbar) {
    this.getToolbar = getToolbar;
    this.active = false;
    this.startedAt = 0;
  }

  /** @returns {Promise<{ startedAt: number }>} */
  async start() {
    const ui = this.getToolbar();
    if (!ui || ui.isDestroyed()) throw new Error('ツールバーがありません');
    if (this.active) throw new Error('すでに録音中です');
    const r = await ui.executeJavaScript('window.__frameshotAudio.start()', true);
    this.active = true;
    this.startedAt = r.startedAt;
    return { startedAt: r.startedAt };
  }

  /**
   * 録音を止めて、一時ファイルに書き出す
   * @returns {Promise<{ file: string, startedAt: number } | null>}
   */
  async stop() {
    const ui = this.getToolbar();
    if (!this.active) return null;
    this.active = false;
    if (!ui || ui.isDestroyed()) return null;
    const b64 = await ui.executeJavaScript('window.__frameshotAudio.stop()', true);
    if (!b64) return null;
    const file = path.join(os.tmpdir(), `frameshot-audio-${process.pid}-${Date.now()}.webm`);
    await fs.promises.writeFile(file, Buffer.from(b64, 'base64'));
    return { file, startedAt: this.startedAt };
  }
}

module.exports = { PageAudio, installDisplayMediaHandler };

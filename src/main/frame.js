// @ts-check
'use strict';

const { WebContentsView } = require('electron');

/**
 * 「撮影サイズ」と「画面に見える大きさ」を分けて持つ枠。
 *
 * - 撮影サイズ（width × height, CSS px）はページから見えるビューポートの大きさ。
 *   CDP の Emulation.setDeviceMetricsOverride で、実際のウィンドウの大きさとは無関係に指定する。
 * - 画面に入りきらないときは、表示だけ縮小する（view の大きさを小さくし、emulation の scale で
 *   ページ全体を縮小して見せる）。ページのレイアウトは常に撮影サイズで行われるので、
 *   プレビューと撮影結果のレイアウトが一致する。
 * - 撮影中だけ、倍率（deviceScaleFactor）を掛けた撮影用の emulation に切り替える。
 */
class Frame {
  /**
   * @param {import('electron').BrowserWindow} win
   * @param {{ partition?: string }} [opts]
   */
  constructor(win, opts = {}) {
    this.win = win;
    this.width = 880;
    this.height = 1320;
    /** 表示の縮小率（1 以下） */
    this.fit = 1;
    this.rect = { x: 0, y: 0, width: 1, height: 1 };
    this.busy = false;
    /** 録画中か。録画中は撮影サイズ（等倍）のまま、見える範囲だけ切り抜いて表示する */
    this.recording = false;
    /** @type {{ cw: number, ch: number, chrome: { top: number, bottom: number, margin: number } } | null} */
    this.lastLayout = null;

    // 外部サイトを開くので、Node も preload も与えず、サンドボックスで隔離する
    this.view = new WebContentsView({
      webPreferences: {
        partition: opts.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // 隠れていても描画を止めない（撮影のため）
        backgroundThrottling: false,
      },
    });
    this.view.setBackgroundColor('#ffffff');
    win.contentView.addChildView(this.view);

    // ページ遷移（プロセスが切り替わる遷移を含む）のあとも、プレビューの emulation を掛け直す
    this.wc.on('did-finish-load', () => void this.applyPreview());
    this.wc.on('did-navigate', () => void this.applyPreview());
  }

  get wc() {
    return this.view.webContents;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async send(method, params) {
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg.sendCommand(method, params);
  }

  /**
   * 撮影サイズを変える（表示の反映は layout() で行う）
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  /**
   * ウィンドウの内側の大きさから、枠の表示位置と縮小率を決めて反映する
   * @param {number} contentWidth
   * @param {number} contentHeight
   * @param {{ top: number, bottom: number, margin: number }} chrome ツールバー・ステータスバーの高さと余白
   */
  layout(contentWidth, contentHeight, chrome) {
    this.lastLayout = { cw: contentWidth, ch: contentHeight, chrome };
    const availW = Math.max(50, contentWidth - chrome.margin * 2);
    const availH = Math.max(50, contentHeight - chrome.top - chrome.bottom - chrome.margin * 2);
    if (this.recording) {
      // 録画中は縮小できない（縮小すると、録画される絵も縮む）。入る分だけ左上から切り抜いて見せる
      const width = Math.min(this.width, availW);
      const height = Math.min(this.height, availH);
      this.fit = 1;
      this.rect = {
        x: Math.round((contentWidth - width) / 2),
        y: chrome.top + chrome.margin + Math.max(0, Math.round((availH - height) / 2)),
        width,
        height,
      };
      if (!this.wc.isDestroyed()) this.view.setBounds(this.rect);
      return;
    }
    const fit = Math.min(1, availW / this.width, availH / this.height);
    const width = Math.max(1, Math.round(this.width * fit));
    // 丸めた幅から縮小率を決め直す（ページ側の拡大縮小と view の大きさを一致させる）
    const scale = width / this.width;
    const height = Math.max(1, Math.round(this.height * scale));
    this.fit = scale;
    this.rect = {
      x: Math.round((contentWidth - width) / 2),
      y: chrome.top + chrome.margin + Math.max(0, Math.round((availH - height) / 2)),
      width,
      height,
    };
    if (!this.busy) void this.applyBoundsAndPreview();
  }

  async applyBoundsAndPreview() {
    if (this.wc.isDestroyed()) return;
    this.view.setBounds(this.rect);
    await this.applyPreview();
  }

  /** 画面表示用の emulation（倍率 1・縮小あり） */
  async applyPreview() {
    // 録画中にページが遷移しても、等倍の emulation を掛け直す（掛け直さないと録画の大きさが変わる）
    if (this.recording) return this.applyRecordingEmulation();
    if (this.busy || this.wc.isDestroyed()) return;
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
        mobile: false,
        scale: this.fit,
        screenWidth: this.width,
        screenHeight: this.height,
      });
    } catch (e) {
      console.warn('[frame] プレビューの emulation に失敗:', e instanceof Error ? e.message : e);
    }
  }

  /** 録画用の emulation（等倍・縮小なし。ページは撮影サイズでレイアウトされる） */
  async applyRecordingEmulation() {
    if (this.wc.isDestroyed()) return;
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: this.width,
        screenHeight: this.height,
      });
    } catch (e) {
      console.warn('[frame] 録画用の emulation に失敗:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * 録画の準備。撮影サイズ・等倍に切り替えて、録画中の扱い（切り抜き表示、撮影の禁止）に入る。
   * 終わったら必ず endRecording() を呼ぶ
   */
  async beginRecording() {
    if (this.busy) throw new Error('撮影中です');
    this.busy = true;
    this.recording = true;
    try {
      if (this.lastLayout) this.layout(this.lastLayout.cw, this.lastLayout.ch, this.lastLayout.chrome);
      await this.applyRecordingEmulation();
      await this.settle();
    } catch (e) {
      this.recording = false;
      this.busy = false;
      throw e;
    }
  }

  /** 録画をやめて、縮小プレビューに戻す */
  async endRecording() {
    this.recording = false;
    this.busy = false;
    if (this.wc.isDestroyed()) return;
    if (this.lastLayout) this.layout(this.lastLayout.cw, this.lastLayout.ch, this.lastLayout.chrome);
    else await this.applyBoundsAndPreview();
  }

  /** 描画が落ち着くのを待つ（2 フレーム待つ。ページが固まっていても 1.5 秒で諦める） */
  async settle() {
    const frames = this.wc
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true)
      .catch(() => false);
    await Promise.race([frames, new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => setTimeout(r, 80));
  }

  /**
   * 撮影用の emulation（等倍の撮影サイズ × deviceScaleFactor）に切り替えて fn を実行し、
   * 終わったらプレビューに戻す。撮影中は layout の反映を止める
   * @template T
   * @param {number} deviceScaleFactor
   * @param {(send: (method: string, params?: Record<string, unknown>) => Promise<any>) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async runCapture(deviceScaleFactor, fn) {
    if (this.busy) throw new Error('撮影中です');
    this.busy = true;
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor,
        mobile: false,
        screenWidth: this.width,
        screenHeight: this.height,
      });
      await this.settle();
      return await fn((method, params) => this.send(method, params));
    } finally {
      this.busy = false;
      await this.applyBoundsAndPreview();
    }
  }

  destroy() {
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch {
      /* すでに閉じている */
    }
    if (!this.wc.isDestroyed()) this.wc.close();
  }
}

module.exports = { Frame };

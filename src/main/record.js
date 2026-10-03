// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { nativeImage } = require('electron');

const { buildFfmpegArgs, buildMuxArgs, dueFrames, totalFrames, evenSize, tailText } = require('../shared/video');

/**
 * @typedef {Object} RecordOptions
 * @property {string} ffmpegPath
 * @property {string} outFile 最終的な保存先（.mp4）。録画中は <outFile>.part に書き、成功したら改名する
 * @property {number} width 撮影サイズ（CSS px）
 * @property {number} height
 * @property {number} fps
 * @property {import('../shared/video').VideoQuality} quality
 * @property {number} maxSeconds これを超えたら自動で止める
 * @property {{ start(): Promise<{ startedAt: number }>, stop(): Promise<{ file: string, startedAt: number } | null> } | null} [audio] 枠の音声（なければ映像だけ）
 * @property {(r: RecordResult) => void} onEnd 利用者の操作以外（最大時間・エラー）で終わったときに呼ぶ
 */

/**
 * @typedef {Object} RecordResult
 * @property {boolean} ok
 * @property {string} message
 * @property {string} [file]
 * @property {number} [bytes]
 * @property {number} [frames]
 * @property {number} [seconds]
 * @property {boolean} [audio] 音声が入っているか
 * @property {string} [warning] 録画は成功したが、音声が入らなかったなどの注意
 * @property {'manual' | 'max' | 'error'} reason
 */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ffmpeg を実行して終わるのを待つ
 * @param {string} bin
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runFfmpeg(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    // 結合が終わらないときに、保存まで巻き込まれないよう、時間で打ち切る
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.once('close', () => clearTimeout(timer));
    let stderr = '';
    p.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    p.once('error', (e) => resolve({ code: null, stderr: e.message }));
    p.once('close', (code) => resolve({ code, stderr }));
  });
}

/**
 * 枠の中身を MP4 に録る。
 *
 * - フレームは CDP の screencast で受ける。ページを撮影サイズ（等倍）にしておけば、画面からはみ出す枠でも全面が届く
 * - 静止したページはフレームが来ないので、一定間隔（fps）で「最新のフレーム」を ffmpeg に書き足す
 * - ffmpeg が遅れたら（stdin が詰まったら）待つ。待った分は、次の周期で同じフレームを重ねて、動画の長さを実時間に合わせる
 * - 受けたフレームは最新の 1 枚しか持たない。デコードも書き込む周期にしか行わない
 */
class Recorder {
  /** @param {InstanceType<typeof import('./frame').Frame>} frame */
  constructor(frame) {
    this.frame = frame;
    this.active = false;
    /** @type {RecordOptions | null} */
    this.opts = null;
    this.startedAt = 0;
    /** @type {Promise<RecordResult> | null} */
    this.ending = null;
    /** 録画を止める要求が出たか */
    this.stopRequested = false;
    /** 録画を続けられなくなった理由（空なら正常） */
    this.failure = '';
    this.written = 0;
    this.stderr = '';
    /** 受けた最新フレーム（base64） @type {string | null} */
    this.latestData = null;
    /** @type {Buffer | null} */
    this.bitmap = null;
    this.dirty = false;
    this.partFile = '';
    /** 音声を録っているか */
    this.audioOn = false;
    this.audioStartedAt = 0;
    /** 音声まわりの注意（録画は続ける） */
    this.warning = '';
    /** @type {import('child_process').ChildProcess | undefined} */
    this.ff = undefined;
    /** @type {Promise<number | null>} */
    this.ffClosed = Promise.resolve(null);
    /** @type {Electron.Debugger | undefined} */
    this.dbg = undefined;
    /** @type {((e: unknown, method: string, params: any) => void) | undefined} */
    this.onMessage = undefined;
    /** @type {Promise<void>} */
    this.loopDone = Promise.resolve();
  }

  /** 録画開始からの経過ミリ秒 */
  get elapsedMs() {
    return this.active ? Date.now() - this.startedAt : 0;
  }

  /** @param {RecordOptions} opts */
  async start(opts) {
    if (this.active) throw new Error('すでに録画中です');
    const { width, height } = opts;
    this.opts = opts;
    this.active = true;
    this.ending = null;
    this.stopRequested = false;
    this.failure = '';
    this.written = 0;
    this.stderr = '';
    this.latestData = null;
    this.bitmap = null;
    this.dirty = false;
    this.audioOn = false;
    this.audioStartedAt = 0;
    this.warning = '';
    this.partFile = `${opts.outFile}.part`;

    try {
      await fs.promises.mkdir(path.dirname(opts.outFile), { recursive: true });
      await this.frame.beginRecording();
    } catch (e) {
      this.active = false;
      throw e;
    }

    try {
      await this.spawnFfmpeg(opts);
      const dbg = this.frame.wc.debugger;
      this.dbg = dbg;
      if (!dbg.isAttached()) dbg.attach('1.3');
      this.onMessage = (_e, method, params) => {
        if (method !== 'Page.screencastFrame') return;
        this.latestData = params.data;
        this.dirty = true;
        // 受け取ったらすぐ返す（返さないと次のフレームが来ない）
        dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      };
      dbg.on('message', this.onMessage);
      await dbg.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        maxWidth: width,
        maxHeight: height,
        everyNthFrame: 1,
      });
      // 最初のフレームが来るまで待つ（静止ページでも、開始直後に 1 枚は来る）
      const t0 = Date.now();
      while (!this.latestData) {
        if (this.failure) throw new Error(this.failure);
        if (Date.now() - t0 > 8000) throw new Error('ページの映像が届きません（8 秒待ちました）');
        await sleep(20);
      }
      this.checkFrameSize(); // 想定と違う大きさなら、ここで例外
    } catch (e) {
      await this.cleanup(true);
      throw e;
    }

    // 音声は映像の直前に始める。始まった時刻の差は、あとで結合するときに補正する
    if (opts.audio) {
      try {
        const a = await opts.audio.start();
        this.audioOn = true;
        this.audioStartedAt = a.startedAt;
      } catch (e) {
        this.warning = `音声は録れませんでした（映像だけ録画）: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    this.startedAt = Date.now();
    this.loopDone = this.loop();
  }

  /** @param {RecordOptions} opts */
  async spawnFfmpeg(opts) {
    const args = buildFfmpegArgs({
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      quality: opts.quality,
      outFile: this.partFile,
    });
    await new Promise((resolve, reject) => {
      const ff = spawn(opts.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      this.ff = ff;
      this.ffClosed = new Promise((r) => ff.once('close', (code) => r(code)));
      ff.stderr?.on('data', (d) => {
        this.stderr = (this.stderr + d).slice(-2000);
      });
      // ffmpeg が先に終わっていても、こちらが書き込んで例外にならないようにする
      ff.stdin?.on('error', () => {});
      ff.once('spawn', () => resolve(undefined));
      ff.once('error', (e) => reject(new Error(`ffmpeg を起動できません: ${e.message}`)));
      ff.once('close', (code) => {
        if (this.active && !this.stopRequested && !this.failure) {
          this.failure = `ffmpeg が途中で終了しました（コード ${code}）${this.stderr ? ': ' + tailText(this.stderr) : ''}`;
        }
      });
    });
  }

  /** 最新フレームを BGRA に直す。大きさが想定と違えば例外 */
  checkFrameSize() {
    const o = /** @type {RecordOptions} */ (this.opts);
    if (!this.dirty && this.bitmap) return this.bitmap;
    const img = nativeImage.createFromBuffer(Buffer.from(/** @type {string} */ (this.latestData), 'base64'));
    const size = img.getSize();
    if (size.width !== o.width || size.height !== o.height) {
      throw new Error(`録画のフレームが撮影サイズと違います（${size.width}×${size.height}、想定 ${o.width}×${o.height}）`);
    }
    this.bitmap = img.toBitmap();
    this.dirty = false;
    return this.bitmap;
  }

  async loop() {
    const o = /** @type {RecordOptions} */ (this.opts);
    const ff = /** @type {import('child_process').ChildProcess} */ (this.ff);
    const stdin = /** @type {NodeJS.WritableStream} */ (ff.stdin);
    const periodMs = 1000 / o.fps;
    try {
      while (this.active && !this.stopRequested && !this.failure) {
        const elapsed = Date.now() - this.startedAt;
        const due = dueFrames(elapsed, o.fps);
        if (due > this.written) {
          const bmp = this.checkFrameSize();
          while (this.written < due && !this.failure) {
            this.written++;
            if (!stdin.write(bmp)) {
              await Promise.race([new Promise((r) => stdin.once('drain', r)), /** @type {Promise<unknown>} */ (this.ffClosed)]);
            }
          }
        }
        if (elapsed >= o.maxSeconds * 1000) {
          void this.end('max');
          return;
        }
        await sleep(Math.max(1, Math.min(periodMs / 3, 20)));
      }
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
    }
    if (this.failure && !this.stopRequested) void this.end('error');
  }

  /**
   * 利用者の操作で止める。終わるまで待って結果を返す
   * @returns {Promise<RecordResult>}
   */
  stop() {
    if (!this.active && !this.ending) return Promise.resolve({ ok: false, message: '録画していません', reason: 'manual' });
    return this.end('manual');
  }

  /** @param {'manual' | 'max' | 'error'} reason @returns {Promise<RecordResult>} */
  end(reason) {
    if (this.ending) return this.ending;
    this.ending = this.finish(reason).then((r) => {
      if (reason !== 'manual') /** @type {RecordOptions} */ (this.opts).onEnd(r);
      return r;
    });
    return this.ending;
  }

  /** @param {'manual' | 'max' | 'error'} reason @returns {Promise<RecordResult>} */
  async finish(reason) {
    const o = /** @type {RecordOptions} */ (this.opts);
    this.stopRequested = true;
    await this.loopDone?.catch(() => {});
    const elapsed = Date.now() - this.startedAt;
    /** @type {{ file: string, startedAt: number } | null} */
    let audio = null;
    if (this.audioOn) {
      this.audioOn = false;
      try {
        audio = (await o.audio?.stop()) ?? null;
        if (!audio) this.warning = '音声が録れていませんでした（映像だけ保存）';
      } catch (e) {
        this.warning = `音声を取り出せませんでした（映像だけ保存）: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    try {
      await this.stopScreencast();
      if (this.failure) throw new Error(this.failure);

      // 録画時間ぴったりの長さになるよう、足りない分は最後のフレームで埋める
      const total = totalFrames(elapsed, o.fps);
      const ff = /** @type {import('child_process').ChildProcess} */ (this.ff);
      const stdin = /** @type {NodeJS.WritableStream} */ (ff.stdin);
      if (this.written < total) {
        const bmp = this.checkFrameSize();
        while (this.written < total && !this.failure) {
          this.written++;
          if (!stdin.write(bmp)) await Promise.race([new Promise((r) => stdin.once('drain', r)), /** @type {Promise<unknown>} */ (this.ffClosed)]);
        }
      }
      stdin.end();
      const code = await this.ffClosed;
      if (code !== 0) throw new Error(`ffmpeg がエラーで終了しました（コード ${code}）${this.stderr ? ': ' + tailText(this.stderr) : ''}`);

      let withAudio = false;
      if (audio) {
        const muxed = `${o.outFile}.mux`;
        try {
          const r = await runFfmpeg(
            o.ffmpegPath,
            buildMuxArgs({ videoFile: this.partFile, audioFile: audio.file, audioOffsetMs: audio.startedAt - this.startedAt, durationSec: this.written / o.fps, outFile: muxed }),
          );
          if (r.code !== 0) throw new Error(tailText(r.stderr) || `コード ${r.code}`);
          await fs.promises.rename(muxed, o.outFile);
          await fs.promises.rm(this.partFile, { force: true });
          withAudio = true;
        } catch (e) {
          this.warning = `音声を結合できませんでした（映像だけ保存）: ${e instanceof Error ? e.message : String(e)}`;
          await fs.promises.rm(muxed, { force: true }).catch(() => {});
          await fs.promises.rename(this.partFile, o.outFile);
        } finally {
          await fs.promises.rm(audio.file, { force: true }).catch(() => {});
        }
      } else {
        await fs.promises.rename(this.partFile, o.outFile);
      }
      const bytes = (await fs.promises.stat(o.outFile)).size;
      await this.cleanup(false);
      const seconds = this.written / o.fps;
      return { ok: true, message: '', file: o.outFile, bytes, frames: this.written, seconds, audio: withAudio, warning: this.warning || undefined, reason };
    } catch (e) {
      if (audio) await fs.promises.rm(audio.file, { force: true }).catch(() => {});
      await this.cleanup(true);
      return { ok: false, message: e instanceof Error ? e.message : String(e), reason: reason === 'manual' ? 'manual' : 'error' };
    }
  }

  async stopScreencast() {
    const dbg = this.dbg;
    if (!dbg) return;
    if (this.onMessage) dbg.removeListener('message', this.onMessage);
    this.onMessage = undefined;
    try {
      if (dbg.isAttached()) await dbg.sendCommand('Page.stopScreencast');
    } catch {
      /* ページが閉じている */
    }
  }

  /**
   * 後始末。失敗したときは ffmpeg を止めて、書きかけのファイルを消す
   * @param {boolean} failed
   */
  async cleanup(failed) {
    if (this.audioOn) {
      this.audioOn = false;
      try {
        const a = await this.opts?.audio?.stop();
        if (a) await fs.promises.rm(a.file, { force: true }).catch(() => {});
      } catch {
        /* 録音を止められなくても、後始末は続ける */
      }
    }
    await this.stopScreencast();
    const ff = this.ff;
    if (ff && failed && ff.exitCode === null) {
      try {
        ff.kill();
      } catch {
        /* すでに終わっている */
      }
      await Promise.race([/** @type {Promise<unknown>} */ (this.ffClosed), sleep(2000)]);
    }
    if (failed && this.partFile) await fs.promises.rm(this.partFile, { force: true }).catch(() => {});
    this.latestData = null;
    this.bitmap = null;
    this.ff = undefined;
    this.dbg = undefined;
    this.active = false;
    await this.frame.endRecording();
  }
}

module.exports = { Recorder, evenSize };

// @ts-check
'use strict';

// 枠のページの音を MediaRecorder で録る。メインプロセスが executeJavaScript（ユーザー操作つき）で呼ぶ。
// getDisplayMedia は、メインプロセスの setDisplayMediaRequestHandler が「枠の webContents の音声」を返す

/** @typedef {{ rec: MediaRecorder, stream: MediaStream, chunks: Blob[], stopped: Promise<void> }} Session */

/** @type {Session | null} */
let session = null;

window.__frameshotAudio = {
  /**
   * 録音を始める。始まった時刻（Date.now）を返す
   * @returns {Promise<{ startedAt: number }>}
   */
  async start() {
    if (session) throw new Error('すでに録音中です');
    // 既定のままだと、マイク用の音声処理（ノイズ抑制・自動音量・エコー除去）が掛かり、モノラルになる。
    // 音楽や効果音が削られたり、音量が勝手に上下したりするので、すべて切ってステレオで録る
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    // 映像は要らないので捨てる（残すと、ずっとページの映像を取り続ける）
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
    if (stream.getAudioTracks().length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('ページの音声を取得できませんでした');
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 192000 });
    /** @type {Blob[]} */
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => {
      rec.onstop = () => resolve(undefined);
    });
    const started = new Promise((resolve) => {
      rec.onstart = () => resolve(Date.now());
    });
    rec.start(1000);
    const startedAt = /** @type {number} */ (await started);
    session = { rec, stream, chunks, stopped };
    return { startedAt };
  },

  /**
   * 録音を止めて、録れた音声（webm）を base64 で返す。何も録れていなければ null
   * @returns {Promise<string | null>}
   */
  async stop() {
    const s = session;
    session = null;
    if (!s) return null;
    if (s.rec.state !== 'inactive') s.rec.stop();
    await s.stopped;
    for (const t of s.stream.getTracks()) t.stop();
    const blob = new Blob(s.chunks, { type: 'audio/webm' });
    if (blob.size === 0) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  },
};

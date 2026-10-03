// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VIDEO, evenSize, buildFfmpegArgs, buildMuxArgs, dueFrames, totalFrames, formatDuration } = require('../src/shared/video');
const { defaults, patchSettings, normalizeSettings } = require('../src/shared/config');

test('evenSize: 奇数は 1px 切り詰め、最小は 2', () => {
  assert.deepEqual(evenSize(881, 1321), { width: 880, height: 1320 });
  assert.deepEqual(evenSize(880, 1320), { width: 880, height: 1320 });
  assert.deepEqual(evenSize(1, 1), { width: 2, height: 2 });
});

test('buildFfmpegArgs: 入力は bgra の rawvideo、出力は偶数に切り詰めた yuv420p', () => {
  const a = buildFfmpegArgs({ width: 881, height: 1321, fps: 15, quality: 'light', outFile: 'o.mp4.part' });
  assert.ok(a.join(' ').includes('-f rawvideo -pix_fmt bgra -s 881x1321 -r 15 -i -'));
  assert.ok(a.includes('crop=880:1320:0:0'));
  assert.equal(a[a.indexOf('-crf') + 1], String(VIDEO.qualities.light.crf));
  assert.ok(a.includes('yuv420p'));
  assert.equal(a.at(-1), 'o.mp4.part');
});

test('dueFrames / totalFrames / formatDuration', () => {
  assert.equal(dueFrames(0, 15), 1);
  assert.equal(dueFrames(1000, 15), 16);
  assert.equal(totalFrames(3000, 15), 45);
  assert.equal(totalFrames(0, 15), 1);
  assert.equal(formatDuration(7000), '00:07');
  assert.equal(formatDuration(3723000), '1:02:03');
});

test('buildMuxArgs: 音声が遅れて始まったら itsoffset、先に始まっていたら ss で頭を切る', () => {
  const base = { videoFile: 'v.mp4', audioFile: 'a.webm', durationSec: 3.2, outFile: 'o.mp4' };
  const late = buildMuxArgs({ ...base, audioOffsetMs: 120 });
  assert.equal(late[late.indexOf('-itsoffset') + 1], '0.120');
  assert.ok(late.indexOf('-itsoffset') < late.indexOf('a.webm'));
  assert.ok(!late.includes('-ss'));
  const early = buildMuxArgs({ ...base, audioOffsetMs: -80 });
  assert.equal(early[early.indexOf('-ss') + 1], '0.080');
  assert.ok(early.indexOf('-ss') < early.indexOf('a.webm'));
  const same = buildMuxArgs({ ...base, audioOffsetMs: 0 });
  assert.ok(!same.includes('-ss') && !same.includes('-itsoffset'));
  // 映像はコピー、音声は AAC、映像の長さ（-t）で終わる
  for (const a of [late, early, same]) {
    assert.ok(a.join(' ').includes('-c:v copy') && a.join(' ').includes('-c:a aac'));
    assert.ok(a.includes('apad') && !a.includes('-shortest')); // -shortest + apad は、映像コピーだと終わらない
    assert.equal(a[a.indexOf('-t') + 1], '3.200');
    assert.equal(a.at(-1), 'o.mp4');
  }
});

test('config: videoAudio は既定 OFF、真偽値だけ受け付ける', () => {
  assert.equal(defaults().videoAudio, false);
  const on = patchSettings(defaults(), { videoAudio: true });
  assert.equal(on.videoAudio, true);
  assert.equal(patchSettings(on, { videoAudio: 'yes' }).videoAudio, true); // 不正な値は今の値のまま
  assert.equal(normalizeSettings({ videoAudio: 1 }).videoAudio, false);
  assert.equal(normalizeSettings({ videoAudio: true }).videoAudio, true);
});

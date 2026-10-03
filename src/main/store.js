// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSettings } = require('../shared/config');

/**
 * 設定・ブックマーク・履歴を userData 配下の JSON 1 ファイルに保存する。
 * 書き込みは少し待ってまとめ、一時ファイル経由で置き換える（途中で落ちても壊れない）
 */
class Store {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {import('../shared/config').Settings} */
    this.data = this.load();
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
  }

  load() {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code !== 'ENOENT') {
        // 壊れていたら退避して、既定値で始める
        try {
          fs.renameSync(this.file, this.file + '.broken');
        } catch {
          /* 退避できなくても続ける */
        }
        console.warn('[store] 設定を読めなかったので既定値で開始:', err.message);
      }
      return normalizeSettings({});
    }
  }

  /**
   * 一部の項目を更新する（検査し直してから保存を予約）
   * @param {Partial<import('../shared/config').Settings>} patch
   */
  update(patch) {
    this.data = normalizeSettings({ ...this.data, ...patch });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  /** 今すぐ書く（終了時など） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[store] 設定を保存できません:', e instanceof Error ? e.message : e);
    }
  }
}

module.exports = { Store };

// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { defaults, normalizeSettings, patchSettings, findPreset, LIMITS } = require('../src/shared/config');
const { normalizeUrl, isAllowedUrl } = require('../src/shared/url');
const { renderName, sanitizeFileName, hostFromUrl, stamp } = require('../src/shared/naming');
const lists = require('../src/shared/lists');

// ---------- config ----------

test('normalizeSettings: 空・壊れた入力は既定値になる', () => {
  assert.deepEqual(normalizeSettings(undefined), normalizeSettings({}));
  assert.deepEqual(normalizeSettings('x'), normalizeSettings(null));
  const s = normalizeSettings({});
  assert.equal(s.width, 880);
  assert.equal(s.height, 1320);
  assert.equal(s.format, 'webp');
});

test('normalizeSettings: 範囲外・不正な値を直す', () => {
  const s = normalizeSettings({ width: 5, height: 99999, scale: 7, format: 'gif', quality: 0, webpLossless: 'yes' });
  assert.equal(s.width, LIMITS.minSize);
  assert.equal(s.height, LIMITS.maxSize);
  assert.equal(s.scale, 1);
  assert.equal(s.format, 'webp');
  assert.equal(s.quality, 1);
  assert.equal(s.webpLossless, false);
});

test('normalizeSettings: file: や javascript: の URL は保存しない', () => {
  assert.equal(normalizeSettings({ url: 'file:///etc/passwd' }).url, '');
  assert.equal(normalizeSettings({ url: 'javascript:alert(1)' }).url, '');
  assert.equal(normalizeSettings({ url: 'https://example.com/' }).url, 'https://example.com/');
});

test('normalizeSettings: プリセット・ブックマーク・履歴の不正な行を落とす', () => {
  const s = normalizeSettings({
    presets: [{ name: 'a', w: 500, h: 600 }, { name: 'a', w: 1, h: 1 }, { name: '', w: 500, h: 600 }, null, { name: 'b', w: 'x', h: 3 }],
    bookmarks: [{ title: 't', url: 'https://a.test/' }, { title: 'x', url: 'file:///x' }, { url: 'https://a.test/' }],
    recent: ['https://a.test/', 'https://a.test/', 'ftp://x', 5],
  });
  assert.deepEqual(s.presets, [{ name: 'a', w: 500, h: 600 }]);
  assert.deepEqual(s.bookmarks, [{ title: 't', url: 'https://a.test/' }]);
  assert.deepEqual(s.recent, ['https://a.test/']);
});

test('patchSettings: 不正な値は今の値のまま、未知のキーは無視', () => {
  const cur = { ...defaults(), width: 1000, height: 700 };
  const next = patchSettings(cur, { width: '', height: 1536, scale: 2, evil: 1, outputDir: '/etc', url: 'x' });
  assert.equal(next.width, 1000); // 空欄 → 今の値
  assert.equal(next.height, 1536);
  assert.equal(next.scale, 2);
  assert.equal(next.outputDir, ''); // patch では変えられない項目
  assert.equal(/** @type {any} */ (next).evil, undefined);
});

test('findPreset: 自分用が標準より優先される', () => {
  assert.deepEqual(findPreset([], 880, 1320), { kind: 'builtin', name: 'ギャラリー縦 880×1320' });
  assert.deepEqual(findPreset([{ name: 'mine', w: 880, h: 1320 }], 880, 1320), { kind: 'custom', name: 'mine' });
  assert.equal(findPreset([], 1, 1), null);
});

// ---------- url ----------

/** @param {string} s */
const url = (s) => {
  const r = normalizeUrl(s);
  return 'url' in r ? r.url : `ERR:${r.error}`;
};

test('normalizeUrl: ホスト名・localhost・IP', () => {
  assert.equal(url('example.com'), 'https://example.com/');
  assert.equal(url('  example.com/a?b=1#c '), 'https://example.com/a?b=1#c');
  assert.equal(url('localhost:4321/works'), 'http://localhost:4321/works');
  assert.equal(url('192.168.0.5:8080'), 'http://192.168.0.5:8080/');
  assert.equal(url('http://example.com'), 'http://example.com/');
});

test('normalizeUrl: 危険・非対応のスキームは拒否', () => {
  assert.match(url('javascript:alert(1)'), /^ERR:/);
  assert.match(url('data:text/html,<h1>x</h1>'), /^ERR:/);
  assert.match(url('ftp://example.com'), /^ERR:/);
  assert.match(url('chrome://gpu'), /^ERR:/);
  assert.match(url('mailto:a@b.c'), /^ERR:/);
  assert.match(url(''), /^ERR:/);
});

test('normalizeUrl: Windows パスと file URL', () => {
  assert.equal(url('C:\\work\\my page\\a.html'), 'file:///C:/work/my%20page/a.html');
  assert.equal(url('file:///tmp/x.html'), 'file:///tmp/x.html');
  assert.equal(url('about:blank'), 'about:blank');
});

test('normalizeUrl: URL でない文字列は検索になる', () => {
  assert.equal(url('hello world'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(url('github'), 'https://www.google.com/search?q=github');
});

test('isAllowedUrl', () => {
  assert.equal(isAllowedUrl('https://a.test/'), true);
  assert.equal(isAllowedUrl('file:///a'), true);
  assert.equal(isAllowedUrl('about:blank'), true);
  assert.equal(isAllowedUrl('javascript:1'), false);
  assert.equal(isAllowedUrl('not a url'), false);
});

// ---------- naming ----------

test('sanitizeFileName: 使えない文字・予約名・末尾のドット', () => {
  assert.equal(sanitizeFileName('a<b>:c"d/e\\f|g?h*i'), 'a_b__c_d_e_f_g_h_i');
  assert.equal(sanitizeFileName('name. '), 'name');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFileName('   '), 'frameshot');
  assert.equal(sanitizeFileName('あ'.repeat(300)).length, 120);
});

test('renderName: 既定テンプレート', () => {
  const ctx = { host: 'lain-lab.com', date: '20261003', time: '110554', width: 880, height: 1320, scale: 1 };
  const t = defaults().nameTemplate;
  assert.equal(renderName(t, ctx), 'lain-lab.com_20261003_110554_880x1320');
  assert.equal(renderName(t, { ...ctx, scale: 2 }), 'lain-lab.com_20261003_110554_880x1320@2x');
});

test('renderName: 未知のトークンは空、パス区切りは潰す', () => {
  const ctx = { host: 'a.test', date: '20261003', time: '000000', width: 1, height: 2, scale: 1, title: 'x/y' };
  assert.equal(renderName('{host}-{nope}-{title}', ctx), 'a.test--x_y');
});

test('hostFromUrl / stamp', () => {
  assert.equal(hostFromUrl('https://www.lain-lab.com/works'), 'lain-lab.com');
  assert.equal(hostFromUrl('http://localhost:4321/'), 'localhost');
  assert.equal(hostFromUrl('file:///tmp/a.html'), 'local');
  assert.equal(hostFromUrl('about:blank'), 'blank');
  assert.equal(hostFromUrl('garbage'), 'page');
  assert.deepEqual(stamp(new Date(2026, 9, 3, 11, 5, 4)), { date: '20261003', time: '110504' });
});

// ---------- lists ----------

test('bookmarks: 追加・外す・並べ替え・削除', () => {
  let b = lists.toggleBookmark([], 'https://a.test/', 'A');
  b = lists.toggleBookmark(b, 'https://b.test/', '  ');
  assert.deepEqual(b, [{ title: 'A', url: 'https://a.test/' }, { title: 'https://b.test/', url: 'https://b.test/' }]);
  assert.equal(lists.isBookmarked(b, 'https://a.test/'), true);
  assert.deepEqual(lists.moveBookmark(b, 1, -1).map((x) => x.title), ['https://b.test/', 'A']);
  assert.deepEqual(lists.moveBookmark(b, 0, -1), b); // 端では動かない
  assert.deepEqual(lists.removeBookmarkAt(b, 0).map((x) => x.url), ['https://b.test/']);
  assert.deepEqual(lists.toggleBookmark(b, 'https://a.test/', 'A').map((x) => x.url), ['https://b.test/']);
  assert.deepEqual(lists.toggleBookmark([], 'file:///x', 'x'), []); // http(s) 以外は追加しない
});

test('recent: 先頭に追加・重複なし・上限・http(s) のみ', () => {
  let r = /** @type {string[]} */ ([]);
  for (let i = 0; i < 30; i++) r = lists.pushRecent(r, `https://a.test/${i}`);
  assert.equal(r.length, LIMITS.maxRecent);
  assert.equal(r[0], 'https://a.test/29');
  r = lists.pushRecent(r, 'https://a.test/20');
  assert.equal(r[0], 'https://a.test/20');
  assert.equal(r.filter((u) => u === 'https://a.test/20').length, 1);
  assert.equal(lists.pushRecent(r, 'file:///x').length, r.length);
});

test('presets: 追加・同名は上書き・削除', () => {
  let p = lists.addPreset([], ' mine ', 500, 600);
  assert.deepEqual(p, [{ name: 'mine', w: 500, h: 600 }]);
  p = lists.addPreset(p, 'mine', 700, 800);
  assert.deepEqual(p, [{ name: 'mine', w: 700, h: 800 }]);
  assert.deepEqual(lists.addPreset(p, '  ', 1, 1), p);
  assert.deepEqual(lists.removePreset(p, 'mine'), []);
});

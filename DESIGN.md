# Frameshot 設計メモ

固定サイズの枠の中に Web ページを表示して、静止画（PNG / JPG / WebP）と動画（MP4）をボタン一つで撮る、デスクトップ用の撮影ツール。

- 名前: **Frameshot**
- 配布: GitHub で無料配布（本体は MIT）
- 対応 OS: Windows を先行、余裕があれば macOS / Linux も同時開発
- 状態: Phase 1（枠 + 外部サイト表示 + 静止画 3 形式）実装済み。動画（Phase 2）は実装済み（等倍のみ、音声は設定で ON/OFF）。Windows・Mac 実機の確認待ち

## 1. 背景

lain-lab.com のギャラリー用サムネ・動画を撮るために、Web 版の撮影ツール `capture-station.astro`（Region Capture 方式）を作って使った。実績は、枠 880×1320 で静止画、15 秒の動画（エンコードで 14MB → 約 1MB）。

このツールで見えた問題が 2 つある。

1. **外部サイトを枠に入れられない。** iframe は相手サイトの `X-Frame-Options` / CSP `frame-ancestors` で拒否される。CORS ではなく埋め込み拒否が原因。
2. **縦長の枠は下が切れる。** `getDisplayMedia` + `cropTo` は「タブに見えている範囲」を録るだけなので、枠がブラウザの表示領域からはみ出すと、はみ出し分は映像に存在しない。モニタの高さが枠の高さの実質的な上限になっていた。

どちらも「ブラウザの外」に出れば解決するので、ネイティブ化する。同種のアプリは調べた限り見当たらなかった。

## 2. 決定事項

| 項目 | 決定 |
|---|---|
| 基盤 | Electron（`WebContentsView` で外部サイトを枠の中に表示） |
| 言語 | プレーン JavaScript（CommonJS）+ JSDoc 型注釈 + `// @ts-check`。live2d-desktop-mascot と同じ構成でビルド工程は増やさず、型の検査だけ `tsc --noEmit` で走らせる |
| ビルド | ビルド工程なし、`electron-builder` でパッケージ（mascot と同じ） |
| 画面 | URL バー + 枠 + ボタン。左の作品リストは作らない |
| 静止画 | CDP でページ自体を指定サイズ・倍率でレンダリング → sharp で PNG / JPG / WebP |
| 動画 | フレーム取得 → fps を揃える → ffmpeg に流して MP4 |
| 音声 | 動画のみ。枠のページの音だけ（設定で ON/OFF、既定 OFF） |
| ライセンス | 本体 MIT。ffmpeg は別プロセスとして起動 |

C# WPF + WebView2 案は撤回した。WebView2 も Windows Graphics Capture も Windows 専用で、macOS / Linux の同時開発と相性が悪いため。

## 3. 画面構成

```
[◀][▶][⟳] [ URL バー ........................ ] [★] [📚]
[ 880 ] × [ 1320 ] [プリセット▾] [2x▾] [UA: PC▾]     [📷] [⏺] [⚙]
┌────────────────────────┐
│  枠（WebContentsView）  │ ← 指定サイズ固定
└────────────────────────┘
```

- 枠がウィンドウに収まらないときは、**表示だけ縮小して撮影は実寸**にする。
- ブックマークは★で追加、📚でドロップダウン。フォルダなし、並べ替えのみ。サイドバーは作らない。
- 枠の中のスクロールやクリックはそのまま操作できる。

## 4. 機能

**必須（Phase 1〜2）**
- URL 指定、W×H 指定、サイズプリセット（自分用の登録も可）
- 静止画 PNG / JPG / WebP、動画 MP4
- 解像度倍率 1x / 2x / 3x（deviceScaleFactor）
- ブックマーク、最近開いた URL
- ファイル名テンプレ（`{host}_{date}_{w}x{h}`）、保存先フォルダ、クリップボードコピー

**あると便利（Phase 3 で取捨選択）**
- 動画の目標サイズ指定（「1MB 以下」で CRF を自動調整）
- フルページ撮影、要素指定撮影（CSS セレクタ）
- UA 切り替え（モバイル / PC、タッチエミュレーション込み）
- 撮影前の遅延（カウントダウン、読み込み後の待ち秒数）
- 自動スクロール動画（上から下へ一定速度）
- ログイン状態の保持（プロファイル = session partition を分ける）
- ダークモード / reduced-motion の強制
- アニメーション WebP / GIF 出力
- クリック・カーソルの可視化（動画のみ）
- ホットキー、トレイ常駐

**後回し**
- 複数 URL の一括撮影（左リストの代わりになる機能）
- Frame モード（任意の画面領域）、音声、撮影履歴ビュー

## 5. 撮影方式

### 静止画
`webContents.debugger`（CDP）で `Emulation.setDeviceMetricsOverride` を指定サイズ・倍率に設定し、`Page.captureScreenshot` で撮る。ページ自体をそのサイズでレンダリングするので、**画面の大きさに依存せず、縦長でも欠けない**。上限は GPU テクスチャの 16384px 前後。撮った PNG を sharp で目的の形式に再エンコードする。

### 動画
CDP の `Page.startScreencast`（jpeg）でフレームを受け、15fps などの一定間隔で「最新の 1 枚」を ffmpeg の stdin（`rawvideo` / bgra）へ書く。静止ページはフレームが来ないので、同じフレームを重ねて長さを実時間に合わせる。ffmpeg が遅れたら待ち、待った分は次の周期で補う。録画時間ぴったりの長さになるよう、停止時に足りない分を最後のフレームで埋める。

録画中だけ、ページを撮影サイズ（等倍）にする。画面には、枠の見える範囲だけが切り抜きで出る（録画は全体）。録画中はサイズ・倍率の変更と静止画の撮影を受け付けない。

出力は書きかけを `.mp4.part` に書き、成功したら改名する（失敗・中断では残さない）。最大録画時間（既定 2 分）で自動停止。録画中にウィンドウを閉じたら、録画を仕上げてから閉じる。

エンコード: `-c:v libx264 -preset medium -pix_fmt yuv420p -movflags +faststart`。画質プリセットは軽量（crf 28）/ 標準（23）/ 高画質（18）。幅と高さは偶数に切り詰める。

### 音声
ツールバー UI が `getDisplayMedia` で**枠の webContents の音声**を受け（メインの `setDisplayMediaRequestHandler` が `audio: page.mainFrame`、`enableLocalEcho: true` を返す）、`MediaRecorder`（opus、ステレオ 192k）で録る。`getDisplayMedia` の既定ではマイク用の処理（エコー除去・ノイズ抑制・自動音量）が掛かり、モノラルになって音楽や効果音が不自然になるので、制約で全部切ってステレオにしている。Windows の loopback（システム全体の音）は使わない。他のアプリの音や通知音が混ざらず、Windows 以外でも使える見込み。映像は不要なので、取得後すぐ捨てる。

録音は別ファイル（一時）に録り、停止時に ffmpeg で映像と結合する（映像はコピー、音声は AAC 192k）。録音と録画の開始時刻の差は、`-itsoffset`（音声が遅れたとき）か `-ss`（先に始まっていたとき）で補正する。出力の長さは映像に合わせる（`-af apad -t 映像の長さ`。`-shortest` は、映像をコピーしているとき apad と組み合わせると終わらないので使わない）。

音声が取れなかった・結合できなかったときは、録画自体は失敗にせず、映像だけ保存して警告を出す。`getDisplayMedia` はユーザー操作が要るので、メインから `executeJavaScript(..., userGesture=true)` で呼ぶ（ショートカットで録画を始めたときも動く）。

ffmpeg は `ffmpeg-static` で同梱する（決定済み）。解決順は、設定の `ffmpegPath` → 同梱 → PATH 上。パッケージ版では `asarUnpack` で展開した側を指す。

**確認済み（Phase 1、Linux + Xvfb）**: 画面の高さ 800px に対して 1536px の枠を 2x で撮り、2048×3072 の全面で四辺とも欠けないことを、実際の Chromium で確かめた（`npm run test:capture`）。元ツールで起きた「下が切れる」は静止画では解消している。

画面に入らないときの表示は、ページを撮影サイズでレイアウトしたまま CDP の `scale` で縮小して見せる。`webContents.capturePage()` が返すのは撮影サイズの画像で、縮小されたページはその左上（view の大きさの範囲）に入る点に注意。

### Phase 2 スパイクの結果（Linux + Xvfb・ソフトウェア GL。Windows 実機は未確認）
1280×800 のウィンドウに、880×1320 の枠（画面からはみ出す）を置いて、取得方法ごとに四辺の色で欠けを判定した。

| 方法 | 結果 |
|---|---|
| 縮小プレビューのまま `Page.startScreencast` | ✕ 縮んだページが左上に入るだけ。下・右が欠ける |
| 実寸の emulation（scale なし）に切り替えて screencast | ✅ 880×1320 全面、四辺とも写る。約 60fps |
| 同上、view を `setVisible(false)` | ✅ 取れる（約 60fps） |
| 同上、view を画面外（x=-4000）に置く | ✕ フレームが来ない |
| `beginFrameSubscription`（実寸 emulation） | ✅ 全面。ただし 30fps 止まり |
| オフスクリーン描画（別ウィンドウ） | ✅ 取れる。ただし別 webContents になり、操作中のページと別物になるので不採用 |
| 2x の screencast / beginFrameSubscription | ✕ フレームは CSS px サイズ（880×1320）のまま。2x の動画は取れない |
| `Page.captureScreenshot` 連打（2x、jpeg） | 約 10fps（1760×2640）。1x は約 17fps |
| 静止ページ | screencast はフレームが 1 枚しか来ない → タイマーで最新フレームを複製して補完 |
| 15fps タイマー補完 → ffmpeg（rawvideo, bgra）→ MP4 | ✅ 5 秒で 75 フレーム、長さ 5.000 秒ぴったり。静止ページでも同じ。奇数サイズ（881×1321）は偶数に切り詰めて 880×1320 |

結論:
1. **はみ出す縦長でも、動画は欠けずに取れる**（実寸 emulation に切り替えれば、view は小さいままでよい）。オフスクリーンに分ける必要はない。
2. **動画は 1x のみ。** 2x 動画は screencast では取れず、captureScreenshot 連打だと約 10fps で現実的でない。
3. 録画中は emulation が実寸になるので、画面表示は縮小プレビューではなく「左上の一部の切り抜き」になる。録画中の見せ方（view を隠して「録画中」を出す、など）が要る。
4. サイズ指定エンコード（目標 1MB など）は未検証。

**Windows 実機で未確認**: GPU が有効な環境で、view が画面からはみ出した状態でも screencast が全面を返すか。実装後、実機で同じ四辺判定を行う。

## 6. 技術構成

live2d-desktop-mascot の `package.json` に揃える。

- Electron（mascot は `^44.5.0`）、`electron-builder`（mascot は `^26.15.3`）
- スクリプト: `start`（`electron .`）、`dist:win`、`dist:mac`、`dist:linux`
- Windows: `nsis`（インストーラー）と `portable`
- macOS: `dmg` と `zip`（arm64 / x64）、署名なし（`identity: null`）
- Linux: `AppImage` と `deb`
- `artifactName` に `${version}` と `${arch}` を入れる
- 単一起動ロック、トレイ、`userData` 配下の JSON で設定を保存、トレイから設定フォルダを開く

```
src/main/      main.js（ウィンドウ・IPC・メニュー）/ frame.js（枠）/ capture.js（静止画）/ clipboard.js / store.js / output.js
src/preload/   preload.js（ツールバー UI への窓口。サンドボックス内なので 1 ファイルで完結させる）
src/renderer/  ツールバー UI（index.html / style.css / renderer.js）とスタートページ
src/shared/    設定・URL・ファイル名・ブックマーク操作（Electron に依存しない純粋なロジック）
test/          単体テスト（node --test）と、実 Chromium での撮影検査（capture.selftest.js）
build/         アイコン置き場（まだ空。electron-builder 用のアイコンは未作成）
```

- 型は JSDoc + `// @ts-check` で、`npm run check`（`tsc --noEmit`）で検査する。
- Electron 44 のクリップボードは非同期の W3C 形式に変わっていて、従来の `clipboard.writeImage` は無い。`clipboard.write([new ClipboardItem(...)])` を使う（`src/main/clipboard.js`）。

### mascot と違えるところ（セキュリティ）
mascot は読み込むのがローカルのファイルだけなので `nodeIntegration: true` / `contextIsolation: false` で動いている。Frameshot は**外部サイトを開く**ので同じにしてはいけない。

- 外部サイトを載せる `WebContentsView` は、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload も付けない。
- ツールバー UI 側だけ preload（`contextBridge`）で IPC を公開する。
- 外部ページから `window.open` された場合は `setWindowOpenHandler` で扱いを決める。

## 7. 配布と ffmpeg

- GitHub Releases で無料配布。本体は MIT。
- ffmpeg は `ffmpeg-static` で同梱する（決定済み）。差し替えは `settings.json` の `ffmpegPath`（設定画面は Phase 3）。
- `THIRD_PARTY_LICENSES.md` に ffmpeg のライセンス文とソースの入手先を書いた。別プロセス起動なので本体を GPL にする必要はない、という整理が一般的。
- `sharp` と `ffmpeg-static` はネイティブバイナリなので、electron-builder で `asarUnpack` の指定が要る見込み。macOS の arm64 / x64 両対応でバイナリが正しく入るかも要確認。
- H.264 には特許の問題が一応ある。気になる場合の逃げ道として VP9 / WebM 出力を用意できる。法的な助言ではない。

## 8. プラットフォーム別の注意

- **macOS**: Frame モードで画面収録の許可が必要。署名なしの配布では Gatekeeper の警告が出る。
- **Linux**: mascot は Wayland での制約から XWayland に固定している（`ozone-platform=x11`）。Frame モードの画面取得は Wayland 側の制約が大きい。まずは Browser モードだけを全 OS 対応にする。
- **GPU なし環境**: mascot は WebGL 用に SwiftShader を明示許可している。WebGL を使うページを撮る可能性があるので、同様の対応が要るか確認する。

## 9. フェーズ

1. ✅ 枠 + 外部サイト表示 + 静止画 3 形式（WebContentsView + CDP + sharp）、ブックマーク・最近開いた URL・自分用プリセット・クリップボード
2. 🔶 動画。実装済み（1x のみ）。Windows 実機の確認と、サイズ指定エンコード（目標 1MB など）が残り
3. 設定画面・ホットキー・トレイ、便利機能の取捨選択
4. Frame モード（任意領域。Windows 先行、macOS、可能なら Linux）
5. 音声

## 10. 検証状況（Phase 1）

**確認済み（Linux + Xvfb、実際の Chromium で）**
- 縦長（1536px）の枠を画面（800px）より大きい状況で撮っても欠けない。1x / 2x、PNG / JPG / WebP（ロスレス含む）
- プレビューのビューポートが撮影サイズと一致し、撮影後にプレビューへ戻る
- URL 入力 → 読み込み → サイズ・倍率・プリセット → 撮影 → 保存 → クリップボードの一連の操作（ツールバーのボタンを実際に押して検査）
- 設定・ブックマーク・履歴の保存と復元、`javascript:` などの拒否

**Windows 実機で未確認**
- 起動、表示崩れ（フォントの違いで 2 段目が窮屈になる可能性。最小幅は 1200px）
- `<select>` のドロップダウンが、枠（ネイティブの view）の下に隠れないか
- 保存先の既定（ピクチャ/Frameshot）、日本語のページタイトルを使ったファイル名
- `electron-builder`（`dist:win` など）。アイコンが未作成なので、まず既定のアイコンで通るかを確かめる

## 11. 未決事項

- 自動スクロール動画など、Phase 3 の機能の優先順位

## 12. 検証状況（Phase 2）

**確認済み（Linux + Xvfb、実際の Chromium と同梱 ffmpeg で）**
- `npm run test:record`（28 項目）: 画面に入らない 880×1320 を録って、動画の四辺（色帯）が全部写る／長さが録画時間どおり／中身が動く／静止ページ・奇数サイズ／すぐ止める／最大時間で自動停止／ffmpeg が死んだとき・起動できないとき／二重開始／録画後に縮小プレビューへ戻る
- 音声（`test:record` の 11 項目）: 鳴っている枠の音が録れて MP4 に AAC で入る／無音の枠でも失敗しない／枠以外のウィンドウの音は入らない（スパイクで確認）／音声を始められない・結合できないときは映像だけ保存して警告／ffmpeg が死んだら録音も止めて一時ファイルを残さない
- 実アプリを CDP でボタン操作した通し検査: ⏺ → 録画中の表示 → 録画中は 📷・サイズ・倍率が無効 → ⏹ → `.mp4` 保存（h264 / yuv420p / 880×1320）→ そのあと 📷 で静止画も撮れる

- アイコン: `build/icon.png`（透明背景）、`icon.ico`（256〜16px。48px 以下は文字なしの版）、`icon-mac.png`（余白つき）。開発中（`npm start`）のウィンドウにも反映
- パッケージ版（Linux の `electron-builder --linux dir`）: ffmpeg と sharp が `app.asar.unpacked` に展開され、その実体を起動して録画・音声・静止画の通し検査が全部通る

**Windows 実機で未確認**
- 音声: 実際の音が入るか、映像とずれないか（開始時刻の補正は未検証。Linux では音を出して確かめられない）、Mac でも枠の音声が取れるか
- GPU 有効の環境で、画面からはみ出す枠の録画が全面を返すか（Linux はソフトウェア描画での確認）
- 15fps / 30fps での実際のフレーム落ち、長時間録画
- ▾ の動画メニュー（ネイティブメニュー）の表示
- `npm run dist:win`（インストーラー・ポータブル）で、同様に ffmpeg が展開されて録画できるか。アイコンが exe・インストーラー・タスクバーに出るか

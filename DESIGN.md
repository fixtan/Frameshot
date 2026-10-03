# Frameshot 設計メモ

固定サイズの枠の中に Web ページを表示して、静止画（PNG / JPG / WebP）と動画（MP4）をボタン一つで撮る、デスクトップ用の撮影ツール。

- 名前: **Frameshot**
- 配布: GitHub で無料配布（本体は MIT）
- 対応 OS: Windows を先行、余裕があれば macOS / Linux も同時開発
- 状態: 設計のみ。実装は未着手

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
| 音声 | 当面なし |
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
`beginFrameSubscription` か CDP の screencast でフレームを取る。静止ページはフレームが来ないので、タイマーで定間隔に最新フレームを補う。有界キューで、ffmpeg が遅れたら古いフレームを捨てる。ffmpeg は `rawvideo` を stdin から受ける。

初期値の例: `-c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -movflags +faststart`。幅と高さは偶数に強制する。ギャラリー用の軽量プリセットと高画質プリセットを設定画面に出す。

### 未確認（Phase 2 のスパイクで確認）
1. **縦長の動画が、画面外にはみ出した領域まで取れるか。** 取れない場合は、撮影用だけオフスクリーンレンダリングにする。その場合、操作用の表示と撮影用の実体を分ける必要がある。
2. 2x のときのフレーム転送負荷（1760×2640 を 15fps）に追いつくか。
3. 静止ページでの定間隔補完と、fps の安定。
4. サイズ指定エンコードが収束するか。

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
src/main/      WebContentsView 管理 / 撮影 / ffmpeg / 設定 / トレイ
src/preload/   IPC ブリッジ
src/renderer/  ツールバー UI（index.html）
src/shared/    設定スキーマ・命名テンプレ・サイズプリセット
build/         アイコン
```

### mascot と違えるところ（セキュリティ）
mascot は読み込むのがローカルのファイルだけなので `nodeIntegration: true` / `contextIsolation: false` で動いている。Frameshot は**外部サイトを開く**ので同じにしてはいけない。

- 外部サイトを載せる `WebContentsView` は、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload も付けない。
- ツールバー UI 側だけ preload（`contextBridge`）で IPC を公開する。
- 外部ページから `window.open` された場合は `setWindowOpenHandler` で扱いを決める。

## 7. 配布と ffmpeg

- GitHub Releases で無料配布。本体は MIT。
- ffmpeg は `ffmpeg-static` で同梱するか、初回起動時にダウンロードさせるかを配布前に決める。どちらでも、設定画面で ffmpeg のパスを差し替えられるようにしておく。
- 同梱するなら `THIRD_PARTY_LICENSES` に ffmpeg のライセンス文とソースの入手先を書く。別プロセス起動なので本体を GPL にする必要はない、という整理が一般的。
- `sharp` と `ffmpeg-static` はネイティブバイナリなので、electron-builder で `asarUnpack` の指定が要る見込み。macOS の arm64 / x64 両対応でバイナリが正しく入るかも要確認。
- H.264 には特許の問題が一応ある。気になる場合の逃げ道として VP9 / WebM 出力を用意できる。法的な助言ではない。

## 8. プラットフォーム別の注意

- **macOS**: Frame モードで画面収録の許可が必要。署名なしの配布では Gatekeeper の警告が出る。
- **Linux**: mascot は Wayland での制約から XWayland に固定している（`ozone-platform=x11`）。Frame モードの画面取得は Wayland 側の制約が大きい。まずは Browser モードだけを全 OS 対応にする。
- **GPU なし環境**: mascot は WebGL 用に SwiftShader を明示許可している。WebGL を使うページを撮る可能性があるので、同様の対応が要るか確認する。

## 9. フェーズ

1. 枠 + 外部サイト表示 + 静止画 3 形式（WebContentsView + CDP + sharp）
2. **スパイク**: フレーム取得 → ffmpeg で MP4（5 章の未確認 4 点）
3. 設定画面・ホットキー・トレイ、便利機能の取捨選択
4. Frame モード（任意領域。Windows 先行、macOS、可能なら Linux）
5. 音声

## 10. 未決事項

- ffmpeg を同梱するか、初回ダウンロードにするか
- 自動スクロール動画など、Phase 3 の機能の優先順位

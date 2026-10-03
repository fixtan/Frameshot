# サードパーティのソフトウェア

Frameshot 本体は [MIT ライセンス](LICENSE)です。配布物には、次のソフトウェアが含まれます。

## FFmpeg（動画の録画に使用）

- 使い方: Frameshot とは**別のプロセス**として起動し、標準入力から映像を渡して MP4 を作ります。Frameshot のコードに FFmpeg をリンクしてはいません。
- 入手元: npm パッケージ [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static)（インストール時にビルド済みバイナリをダウンロード）。バイナリの出どころは、同パッケージの README によると次のとおりです。
  - Windows: <https://www.gyan.dev/ffmpeg/builds/>
  - Linux: <https://johnvansickle.com/ffmpeg/>
  - macOS: <https://evermeet.cx/pub/ffmpeg/>（x64）、<https://osxexperts.net/>（arm64）
- ライセンス: これらのビルドは x264 などを含む **GNU General Public License v3** です。ライセンス全文は、配布物の中の `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.LICENSE` にあります。`ffmpeg-static` 自体のライセンスは GPL-3.0-or-later です。
- ソースコード: FFmpeg のソースは <https://ffmpeg.org/download.html>、x264 のソースは <https://www.videolan.org/developers/x264.html> から入手できます。各ビルドの構成は、上の入手元に記載があります。
- 差し替え: 同梱の FFmpeg を使いたくない場合は、設定ファイル（`settings.json`）の `ffmpegPath` に、自分で用意した FFmpeg の場所を書くと、そちらが使われます。

## Electron / Chromium

Electron に含まれる各種ライセンスは、配布物の `LICENSE.electron.txt` と `LICENSES.chromium.html` にあります。

## sharp / libvips（静止画の変換に使用）

- [sharp](https://github.com/lovell/sharp): Apache License 2.0
- libvips（`@img/sharp-libvips-*`）: LGPL-3.0-or-later

その他の npm 依存パッケージは、それぞれのライセンスに従います（`node_modules/*/LICENSE` を参照）。

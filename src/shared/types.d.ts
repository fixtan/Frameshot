// メインプロセス ↔ ツールバー UI の間でやり取りする型

export interface Preset {
  name: string;
  w: number;
  h: number;
}

export interface FrameshotState {
  /** 開いているページの URL（スタートページのときは空） */
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  bookmarked: boolean;
  /** 今のページをブックマークできるか（http/https のみ） */
  bookmarkable: boolean;

  width: number;
  height: number;
  scale: number;
  format: 'png' | 'jpg' | 'webp';
  quality: number;
  webpLossless: boolean;
  nameTemplate: string;
  copyToClipboard: boolean;

  /** 保存先（既定のときは既定の場所を解決したもの） */
  outputDir: string;
  builtinPresets: Preset[];
  presets: Preset[];

  /** 出力ピクセル（サイズ × 倍率） */
  outWidth: number;
  outHeight: number;
  /** 表示の縮小率 */
  fit: number;
  /** ウィンドウ内での枠の位置と大きさ（CSS px） */
  rect: { x: number; y: number; width: number; height: number };
  /** 撮影中または録画中（撮影・コピー・サイズ変更を止める） */
  busy: boolean;
  recording: boolean;
  videoFps: number;
  videoQuality: 'light' | 'standard' | 'high';
  videoMaxSec: number;
  videoAudio: boolean;
}

export type StatusKind = 'info' | 'ok' | 'error' | 'rec';

export interface StatusMessage {
  message: string;
  kind: StatusKind;
}

export interface CaptureResponse {
  ok: boolean;
  message: string;
  file?: string;
}

export interface PatchableSettings {
  width?: number;
  height?: number;
  scale?: number;
  format?: 'png' | 'jpg' | 'webp';
  quality?: number;
  webpLossless?: boolean;
  nameTemplate?: string;
  copyToClipboard?: boolean;
  videoFps?: number;
  videoQuality?: 'light' | 'standard' | 'high';
  videoMaxSec?: number;
  videoAudio?: boolean;
}

export interface FrameshotApi {
  getState(): Promise<FrameshotState>;
  navigate(input: string): Promise<{ ok: boolean }>;
  nav(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>;
  patch(patch: PatchableSettings): Promise<void>;
  captureStill(mode: 'save' | 'copy'): Promise<CaptureResponse>;
  toggleRecord(): Promise<CaptureResponse>;
  showVideoMenu(): Promise<void>;
  chooseOutputDir(): Promise<void>;
  openOutputDir(): Promise<void>;
  toggleBookmark(): Promise<void>;
  showBookmarks(): Promise<void>;
  addPreset(name: string): Promise<void>;
  removePreset(name: string): Promise<void>;
  onState(cb: (state: FrameshotState) => void): () => void;
  onStatus(cb: (status: StatusMessage) => void): () => void;
  onFocusUrl(cb: () => void): () => void;
}

declare global {
  interface Window {
    frameshot: FrameshotApi;
    /** 枠の音声の録音（src/renderer/audio-capture.js）。メインプロセスから呼ばれる */
    __frameshotAudio: {
      start(): Promise<{ startedAt: number }>;
      stop(): Promise<string | null>;
    };
  }
}

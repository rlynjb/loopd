import type {
  FFmpegKit as FFmpegKitType,
  ReturnCode as ReturnCodeType,
  FFmpegKitConfig as FFmpegKitConfigType,
} from '@wokcito/ffmpeg-kit-react-native';

// Lazy-loaded: FFmpeg allocates ~234MB of native heap at first import.
// Keep it out of the app cold-start path.
let _FFmpegKit: typeof FFmpegKitType;
let _ReturnCode: typeof ReturnCodeType;
let _FFmpegKitConfig: typeof FFmpegKitConfigType;

export async function getFFmpeg() {
  if (!_FFmpegKit) {
    const mod = await import('@wokcito/ffmpeg-kit-react-native');
    _FFmpegKit = mod.FFmpegKit;
    _ReturnCode = mod.ReturnCode;
    _FFmpegKitConfig = mod.FFmpegKitConfig;
  }
  return { FFmpegKit: _FFmpegKit, ReturnCode: _ReturnCode, FFmpegKitConfig: _FFmpegKitConfig };
}

export function quoteFFmpegPath(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

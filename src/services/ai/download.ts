// Model download for on-device Gemma. Streams the GGUF to disk with
// progress reporting via expo-file-system's resumable-download API.
//
// Always uses the legacy expo-file-system entry point — its
// createDownloadResumable is the well-known stable surface for large-file
// downloads with progress callbacks and resume-on-interrupt semantics.
// The newer File/Directory API hasn't fully replaced this yet for the
// progress-callback use case.

import * as FileSystem from 'expo-file-system/legacy';
import {
  getModelPath, MODEL_FILENAME,
  unloadLlamaContext, resetGemmaLocalSkip,
} from './providers/gemma';

// Bartowski community quantizations on HuggingFace — the standard pick
// for mobile inference. Q4_K_M is the canonical 4-bit quantization with
// k-means clusters; balances size and quality well.
const MODEL_URL_4B =
  'https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf';
const MODEL_URL_1B =
  'https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf';

export type ModelVariant = 'gemma-3-4b' | 'gemma-3-1b';

export type DownloadProgress = {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
  fraction: number; // 0 - 1
};

function urlFor(variant: ModelVariant): string {
  return variant === 'gemma-3-1b' ? MODEL_URL_1B : MODEL_URL_4B;
}

// Idempotent — creates the loopd/models/ subdirectory if missing.
async function ensureModelsDir(): Promise<void> {
  const dir = `${FileSystem.documentDirectory}loopd/models/`;
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

// Streams the model file to MODEL_FILENAME in the loopd models dir.
// Reports progress via the optional callback. Releases any cached llama
// context first since the underlying file may be about to change.
//
// Phase 5b ships variant='gemma-3-4b' as the only practical choice; Phase
// 5d's device-class router will pass 'gemma-3-1b' when running on a
// memory-constrained device. Note: today both variants write to the same
// MODEL_FILENAME path. Phase 5d updates MODEL_FILENAME to be
// variant-aware so a device that switches classes doesn't clobber the
// other variant's bytes.
export async function downloadGemmaModel(
  variant: ModelVariant = 'gemma-3-4b',
  onProgress?: (p: DownloadProgress) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureModelsDir();
    await unloadLlamaContext();

    const url = urlFor(variant);
    const destPath = getModelPath();

    const callback = (p: FileSystem.DownloadProgressData) => {
      if (!onProgress) return;
      const written = p.totalBytesWritten;
      const expected = p.totalBytesExpectedToWrite;
      onProgress({
        totalBytesWritten: written,
        totalBytesExpectedToWrite: expected,
        fraction: expected > 0 ? written / expected : 0,
      });
    };

    const resumable = FileSystem.createDownloadResumable(url, destPath, {}, callback);
    const result = await resumable.downloadAsync();
    if (!result) {
      return { success: false, error: 'Download did not complete' };
    }
    // Fresh download — clear any per-chain auto-skip flags from the
    // previous install so we re-probe the new model's perf.
    await resetGemmaLocalSkip();
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Removes the downloaded model from disk + drops the cached context.
// Wired to the Settings "Remove model" button.
export async function deleteGemmaModel(): Promise<{ success: boolean }> {
  try {
    await unloadLlamaContext();
    const destPath = getModelPath();
    const info = await FileSystem.getInfoAsync(destPath);
    if (info.exists) {
      await FileSystem.deleteAsync(destPath, { idempotent: true });
    }
    // Clear probe state so a future re-download starts fresh.
    await resetGemmaLocalSkip();
    return { success: true };
  } catch (err) {
    console.warn('[loopd ai] deleteGemmaModel failed:', err);
    return { success: false };
  }
}

// Returns the size of the downloaded model in bytes, or 0 if absent.
// Used by Settings to render "2.4 GB on disk".
export async function getModelDiskSize(): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(getModelPath());
    if (!info.exists) return 0;
    // Size is included by default in FileInfo when the file exists.
    return (info as { size?: number }).size ?? 0;
  } catch {
    return 0;
  }
}

// Re-exported for the Settings UI so it can display the filename without
// re-importing it from providers/gemma directly.
export { MODEL_FILENAME };

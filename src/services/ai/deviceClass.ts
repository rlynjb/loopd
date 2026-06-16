// Device classification for on-device Gemma inference.
//
// Reads total RAM via expo-device and maps to one of three classes:
//   - 'full'      >= 4 GB total -> Gemma 3 4B (~2.5 GB quantized)
//   - 'small'     2-4 GB        -> Gemma 3 1B (~700 MB)
//   - 'disabled'  < 2 GB        -> on-device unavailable; cloud or
//                                  strict-local error
//
// Phase C's shouldUseGemmaLocal() will consult this alongside model-download
// state when deciding whether to route a chain to on-device Gemma. The
// classification is cached for the session — read once and reuse — and
// allows a user override via SecureStore for cases where the heuristic is
// wrong (Android Go reporting full RAM, or an emulator with unrealistic
// values).

import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';

const KEY_DEVICE_CLASS_OVERRIDE = 'device_class_override';

export type DeviceClass = 'full' | 'small' | 'disabled';

const FULL_THRESHOLD_GB = 4;
const SMALL_THRESHOLD_GB = 2;
const GB = 1024 * 1024 * 1024;

let _cached: DeviceClass | null = null;

// Computed once per session. Subsequent calls return the cached value.
// Call setDeviceClassOverride(null) to force a re-detection next call.
export async function detectDeviceClass(): Promise<DeviceClass> {
  if (_cached !== null) return _cached;

  // User override wins. Use this when the heuristic guesses wrong.
  const override = await SecureStore.getItemAsync(KEY_DEVICE_CLASS_OVERRIDE);
  if (override === 'full' || override === 'small' || override === 'disabled') {
    _cached = override;
    return override;
  }

  const totalMemory = Device.totalMemory;
  if (typeof totalMemory !== 'number' || totalMemory <= 0) {
    // expo-device returned an unusable value (older Android, simulator).
    // Conservative default: small. The user can override if their device
    // is actually capable of the full model.
    _cached = 'small';
    return _cached;
  }

  const totalGB = totalMemory / GB;
  if (totalGB >= FULL_THRESHOLD_GB) {
    _cached = 'full';
  } else if (totalGB >= SMALL_THRESHOLD_GB) {
    _cached = 'small';
  } else {
    _cached = 'disabled';
  }
  return _cached;
}

// Force a device-class. Setting null clears the override and the next
// detectDeviceClass call re-reads RAM and re-derives. Wired to a Settings
// → AI → Device class section in a later commit.
export async function setDeviceClassOverride(cls: DeviceClass | null): Promise<void> {
  if (cls === null) {
    await SecureStore.deleteItemAsync(KEY_DEVICE_CLASS_OVERRIDE);
  } else {
    await SecureStore.setItemAsync(KEY_DEVICE_CLASS_OVERRIDE, cls);
  }
  _cached = null;
}

// Diagnostic info for the Settings page. Reports the chosen class alongside
// the raw memory + device strings so the user can sanity-check the decision.
export async function getDeviceInfo(): Promise<{
  deviceClass: DeviceClass;
  totalMemoryGB: number;
  modelName: string | null;
  brand: string | null;
  overrideActive: boolean;
}> {
  const deviceClass = await detectDeviceClass();
  const overrideRaw = await SecureStore.getItemAsync(KEY_DEVICE_CLASS_OVERRIDE);
  const overrideActive = overrideRaw === 'full' || overrideRaw === 'small' || overrideRaw === 'disabled';
  const totalMemory = Device.totalMemory;
  const totalMemoryGB = typeof totalMemory === 'number' ? totalMemory / GB : 0;
  return {
    deviceClass,
    totalMemoryGB,
    modelName: Device.modelName,
    brand: Device.brand,
    overrideActive,
  };
}

// Returns the Gemma model variant that should run on this device. The
// model-download UX (later commit) uses this to decide which weights to
// fetch on first install.
export async function getRecommendedGemmaModel(): Promise<{
  variant: 'gemma-3-4b' | 'gemma-3-1b' | null;
  approxSizeMB: number;
}> {
  const cls = await detectDeviceClass();
  if (cls === 'full') return { variant: 'gemma-3-4b', approxSizeMB: 2500 };
  if (cls === 'small') return { variant: 'gemma-3-1b', approxSizeMB: 700 };
  return { variant: null, approxSizeMB: 0 };
}

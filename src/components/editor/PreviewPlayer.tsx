import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import Video, { type VideoRef, type OnLoadData, type OnVideoErrorData } from 'react-native-video';
import { File as FSFile } from 'expo-file-system';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { FILTERS } from '../../constants/filters';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../types/project';

function FilterPreview({ filter, filterPreset }: { filter: FilterOverlay; filterPreset: typeof FILTERS[number] | null }) {
  const b = filter.brightness ?? 100;
  const c = filter.contrast ?? 100;
  const s = filter.saturate ?? 100;
  const brightnessDelta = (b - 100) / 100;
  const contrastDelta = (c - 100) / 100;
  const desatAmount = s < 100 ? (100 - s) / 100 : 0;
  const tint = filterPreset?.tint ?? null;
  const tintOpacity = filterPreset?.tintOpacity ?? 0;

  return (
    <View style={styles.filterOverlay} pointerEvents="none">
      {brightnessDelta > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#fff', opacity: Math.min(0.35, brightnessDelta * 0.4) }]} />
      )}
      {brightnessDelta < 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#000', opacity: Math.min(0.4, Math.abs(brightnessDelta) * 0.5) }]} />
      )}
      {contrastDelta > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#000', opacity: Math.min(0.15, contrastDelta * 0.15) }]} />
      )}
      {contrastDelta < 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#808080', opacity: Math.min(0.25, Math.abs(contrastDelta) * 0.3) }]} />
      )}
      {desatAmount > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#808080', opacity: Math.min(0.55, desatAmount * 0.55) }]} />
      )}
      {tint && tintOpacity > 0 && (
        <View style={[styles.filterTint, { backgroundColor: tint, opacity: tintOpacity }]} />
      )}
    </View>
  );
}

const BUFFER_CONFIG = {
  minBufferMs: 1000,
  maxBufferMs: 3000,
  bufferForPlaybackMs: 500,
  bufferForPlaybackAfterRebufferMs: 1000,
};

function checkFileExists(clipUri: string | null | undefined): boolean {
  if (!clipUri) return false;
  try {
    if (clipUri.startsWith('content://')) return true;
    if (!clipUri.includes('/')) return false;
    const file = new FSFile(clipUri.startsWith('file://') ? clipUri : `file://${clipUri}`);
    return file.exists;
  } catch {
    return false;
  }
}

// One of two video slots. Holds its own Video component + state.
// When isActive=false, the Video is paused, muted, and invisible — but still loaded,
// so when it becomes active there's no reload/black-frame glitch.
function VideoSlot({
  clip,
  seekSec,
  isActive,
  isPlaying,
  onProgress,
  onEnded,
  onError,
}: {
  clip: ClipItem | null;
  seekSec: number;
  isActive: boolean;
  isPlaying: boolean;
  onProgress?: (clipId: string, t: number) => void;
  onEnded?: (clipId: string) => void;
  onError?: (msg: string) => void;
}) {
  const videoRef = useRef<VideoRef>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [fileExists, setFileExists] = useState(false);

  const clipUri = clip?.clipUri ?? null;
  const hasClipUri = !!(clipUri && clipUri.length > 0);
  const hasVideo = hasClipUri && fileExists;

  useEffect(() => {
    setFileExists(checkFileExists(clipUri));
  }, [clipUri]);

  // Reset status + loaded-marker when URI changes
  const lastUriRef = useRef<string | null>(null);
  const loadedUriRef = useRef<string | null>(null);
  useEffect(() => {
    if (clipUri !== lastUriRef.current) {
      setStatus(hasVideo ? 'loading' : 'idle');
      lastUriRef.current = clipUri;
      loadedUriRef.current = null;
    }
  }, [clipUri, hasVideo]);

  // Refs for stable callbacks
  const seekSecRef = useRef(seekSec);
  seekSecRef.current = seekSec;
  const clipIdRef = useRef(clip?.id);
  clipIdRef.current = clip?.id;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Seek once when clip URI changes (on fresh load)
  const lastSeekUriRef = useRef<string | null>(null);
  useEffect(() => {
    if (!videoRef.current || !clipUri) return;
    if (status !== 'ready' && status !== 'loading') return;
    if (lastSeekUriRef.current === clipUri) return;
    lastSeekUriRef.current = clipUri;
    videoRef.current.seek(seekSecRef.current);
  }, [clipUri, status]);

  // Re-seek on scrub (active slot, paused)
  useEffect(() => {
    if (!isActive || isPlaying) return;
    if (!videoRef.current) return;
    if (status !== 'ready' && status !== 'loading') return;
    videoRef.current.seek(seekSec);
  }, [seekSec, isPlaying, isActive, status]);

  // Re-seek at the paused → playing transition. Scrub-seeks may still be in flight
  // when the user hits play, so without this the video can start from wherever the
  // last pending seek hadn't settled (often the previous boundary). Only clips
  // that stay mounted across the scrub (usually clips near the active slot) hit
  // this race; freshly mounted slots naturally seek on load.
  const wasPlayingRef = useRef(isPlaying);
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    if (!isPlaying || wasPlaying) return;
    if (!isActive || !videoRef.current) return;
    if (status !== 'ready' && status !== 'loading') return;
    if (__DEV__) {
      console.log('[preview slot] play-start seek', {
        clipId: clipIdRef.current,
        seekSec: Number(seekSecRef.current.toFixed(3)),
        status,
      });
    }
    videoRef.current.seek(seekSecRef.current);
  }, [isPlaying, isActive, status]);

  // Delay the paused→playing flip by ~150ms so ExoPlayer has time to apply the
  // latest seek (scrub updates issue seeks as fast as scroll events fire; pressing
  // play immediately after releasing the scrub otherwise races the seek). Pausing
  // is immediate — no delay on playing→paused.
  const [renderPaused, setRenderPaused] = useState(true);
  useEffect(() => {
    if (!isPlaying) {
      setRenderPaused(true);
      return;
    }
    const timer = setTimeout(() => setRenderPaused(false), 150);
    return () => clearTimeout(timer);
  }, [isPlaying]);

  const handleLoad = useCallback((data: OnLoadData) => {
    setStatus('ready');
    loadedUriRef.current = lastUriRef.current;
    if (__DEV__) {
      console.log('[preview slot] onLoad', {
        clipId: clipIdRef.current,
        active: isActiveRef.current,
        seekTo: Number((seekSecRef.current ?? 0).toFixed(3)),
        nativeDuration: Number(((data as { duration?: number })?.duration ?? 0).toFixed(3)),
        t: Math.round(performance.now()),
      });
    }
    if (videoRef.current && seekSecRef.current > 0) {
      videoRef.current.seek(seekSecRef.current);
    }
  }, []);

  const handleError = useCallback((e: OnVideoErrorData) => {
    setStatus('error');
    const msg = e?.error?.errorString ?? e?.error?.errorException ?? e?.error?.error ?? 'Unknown error';
    onError?.(String(msg));
  }, [onError]);

  const handleProgress = useCallback((e: { currentTime: number }) => {
    if (!isActiveRef.current) return;
    if (clipIdRef.current) onProgressRef.current?.(clipIdRef.current, e.currentTime);
  }, []);

  const handleEnd = useCallback(() => {
    if (!isActiveRef.current) return;
    // Ignore stale onEnd from an old source that hadn't finished loading the new URI
    if (loadedUriRef.current == null || loadedUriRef.current !== lastUriRef.current) return;
    if (clipIdRef.current) onEndedRef.current?.(clipIdRef.current);
  }, []);

  const videoSource = useMemo(
    () => (clipUri ? { uri: clipUri } : null),
    [clipUri],
  );

  if (!hasVideo || !videoSource || status === 'error') return null;

  // On Android, Video components use SurfaceView which ignores opacity and
  // always renders on top. Hide inactive slot by translating it offscreen;
  // the native player stays mounted so its preloaded buffer is preserved.
  const hideStyle = !isActive || status !== 'ready'
    ? { transform: [{ translateX: 100000 }] }
    : null;

  return (
    <Video
      ref={videoRef}
      source={videoSource}
      style={[styles.video, hideStyle]}
      resizeMode="cover"
      paused={!isActive || renderPaused}
      repeat={false}
      muted={!isActive}
      onLoad={handleLoad}
      onError={handleError}
      onProgress={handleProgress}
      onEnd={handleEnd}
      progressUpdateInterval={50}
      maxBitRate={2000000}
      bufferConfig={BUFFER_CONFIG}
    />
  );
}

type Props = {
  currentClip: ClipItem | null;
  currentClipSeekSec: number;
  nextClip: ClipItem | null;
  isPlaying: boolean;
  visibleTexts: TextOverlay[];
  visibleFilter: FilterOverlay | null;
  selectedTextId: string | null;
  focusTextInput?: boolean;
  onSelectText: (id: string) => void;
  onUpdateText?: (id: string, text: string) => void;
  previewHeight?: number;
  onPlaybackProgress?: (clipId: string, currentTimeSec: number) => void;
  onPlaybackEnd?: (clipId: string) => void;
};

function getTrimStartSec(clip: ClipItem | null): number {
  if (!clip) return 0;
  return (clip.durationMs / 1000) * clip.trimStartPct / 100;
}

export function PreviewPlayer({
  currentClip,
  currentClipSeekSec,
  nextClip,
  isPlaying,
  visibleTexts,
  visibleFilter,
  selectedTextId,
  onSelectText,
  focusTextInput = false,
  onUpdateText,
  previewHeight = 320,
  onPlaybackProgress,
  onPlaybackEnd,
}: Props) {
  const filterPreset = visibleFilter ? (FILTERS.find(f => f.id === visibleFilter.filterId) ?? null) : null;

  // Two-slot ping-pong. The active slot holds currentClip; the other preloads nextClip.
  // On a clip transition where nextClip becomes current, we swap activeSlot — instant visual
  // cut since the next video is already loaded, no source change on either Video.
  //
  // The preload only runs while playing. During pause/scrub, the inactive slot holds
  // null so only one MediaCodec decoder is alive — scrubbing fast across clip boundaries
  // otherwise thrashes two concurrent decoders and stutters on Android. The first
  // transition after pressing play will briefly spin up the preload.
  const [slots, setSlots] = useState<[ClipItem | null, ClipItem | null]>(() => [currentClip, isPlaying ? nextClip : null]);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);

  useEffect(() => {
    if (!currentClip) {
      setSlots([null, null]);
      setActiveSlot(0);
      return;
    }
    const preload = isPlaying ? nextClip : null;
    setSlots(prev => {
      const curIdx = prev.findIndex(c => c?.id === currentClip.id);
      if (curIdx === -1) {
        // Non-adjacent jump (e.g., seek). Reset both slots.
        setActiveSlot(0);
        return [currentClip, preload];
      }
      setActiveSlot(curIdx as 0 | 1);
      const otherIdx = curIdx === 0 ? 1 : 0;
      if (prev[otherIdx]?.id === preload?.id) return prev;
      const updated = [...prev] as [ClipItem | null, ClipItem | null];
      updated[otherIdx] = preload;
      return updated;
    });
  }, [currentClip?.id, nextClip?.id, isPlaying]);

  // Per-slot seek: the active slot uses currentClipSeekSec (tracks scrub, trim); inactive uses trimStart.
  const slot0SeekSec = slots[0] && currentClip && slots[0].id === currentClip.id
    ? currentClipSeekSec
    : getTrimStartSec(slots[0]);
  const slot1SeekSec = slots[1] && currentClip && slots[1].id === currentClip.id
    ? currentClipSeekSec
    : getTrimStartSec(slots[1]);

  // Error handling at parent level
  const [videoStatus, setVideoStatus] = useState<'ready' | 'error'>('ready');
  const [errorMsg, setErrorMsg] = useState('');
  const handleSlotError = useCallback((msg: string) => {
    setVideoStatus('error');
    setErrorMsg(msg);
  }, []);
  useEffect(() => {
    // Reset error when currentClip changes
    setVideoStatus('ready');
    setErrorMsg('');
  }, [currentClip?.id]);

  // File existence for current clip (for fallback UI)
  const currentClipUri = currentClip?.clipUri;
  const hasClipUri = !!(currentClipUri && currentClipUri.length > 0);
  const [currentFileExists, setCurrentFileExists] = useState(false);
  useEffect(() => {
    setCurrentFileExists(checkFileExists(currentClipUri));
  }, [currentClipUri]);
  const hasCurrentVideo = hasClipUri && currentFileExists;

  return (
    <View style={[styles.preview, { width: '100%', height: '100%' }]}>
      {/* Two video slots — both always mounted. Swap visibility instead of reloading. */}
      <VideoSlot
        clip={slots[0]}
        seekSec={slot0SeekSec}
        isActive={activeSlot === 0}
        isPlaying={isPlaying}
        onProgress={onPlaybackProgress}
        onEnded={onPlaybackEnd}
        onError={handleSlotError}
      />
      <VideoSlot
        clip={slots[1]}
        seekSec={slot1SeekSec}
        isActive={activeSlot === 1}
        isPlaying={isPlaying}
        onProgress={onPlaybackProgress}
        onEnded={onPlaybackEnd}
        onError={handleSlotError}
      />

      {/* Fallback for clips with no video file */}
      {currentClip && !hasCurrentVideo && (
        <>
          <View style={[styles.colorBg, { backgroundColor: currentClip.color }]} />
          <View style={styles.centerContent}>
            <Icon name="video" size={24} color={colors.textDim} />
            <Text style={styles.captionText} numberOfLines={3}>
              {hasClipUri && !currentFileExists ? 'File missing' : currentClip.caption}
            </Text>
          </View>
        </>
      )}

      {/* Error state — shows URI for debugging */}
      {videoStatus === 'error' && (
        <View style={styles.centerContent}>
          <Text style={styles.errorIcon}>!</Text>
          <Text style={styles.errorText}>{errorMsg}</Text>
          <Text style={styles.uriText} numberOfLines={3}>
            {currentClip?.clipUri}
          </Text>
        </View>
      )}

      {/* Filter overlay — approximate B/C/S */}
      {visibleFilter && <FilterPreview filter={visibleFilter} filterPreset={filterPreset} />}

      {/* Text overlays */}
      {visibleTexts.map(t => {
        const scale = previewHeight / 320;
        const scaledSize = Math.max(6, Math.round(t.fontSize * scale * 0.7));
        const isSelected = selectedTextId === t.id;
        const align = t.textAlign ?? 'center';
        const pos = t.position ?? 'bottom';
        const posStyle = pos === 'top'
          ? { top: 8, bottom: undefined, justifyContent: 'flex-start' as const }
          : pos === 'center'
            ? { top: 8, bottom: 8, justifyContent: 'center' as const }
            : { top: undefined, bottom: 8, justifyContent: 'flex-end' as const };
        return (
          <Pressable
            key={t.id}
            onPress={() => { if (!isSelected) onSelectText(t.id); }}
            style={[styles.textOverlayWrap, posStyle]}
          >
            {isSelected && onUpdateText ? (
              <TextInput
                key={`input-${t.id}`}
                value={t.text}
                onChangeText={text => onUpdateText(t.id, text)}
                placeholder="Type here..."
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoFocus={focusTextInput}
                style={{
                  fontFamily: `Nunito${t.italic ? 'Italic' : ''}${t.fontWeight}`,
                  fontSize: scaledSize,
                  lineHeight: scaledSize * (t.lineHeight ?? 14) / 10,
                  color: t.color,
                  textAlign: align,
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.4)',
                  borderStyle: 'dashed',
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 3,
                  minWidth: '80%',
                  minHeight: scaledSize + 16,
                  maxWidth: '100%',
                }}
                multiline
                scrollEnabled
                blurOnSubmit={false}
                returnKeyType="default"
              />
            ) : (
              <Text style={{
                fontFamily: `Nunito${t.italic ? 'Italic' : ''}${t.fontWeight}`,
                fontSize: scaledSize,
                lineHeight: scaledSize * (t.lineHeight ?? 14) / 10,
                color: t.color,
                textAlign: align,
                borderWidth: 0,
                paddingHorizontal: 6,
                borderRadius: 3,
              }}>
                {t.text}
              </Text>
            )}
          </Pressable>
        );
      })}

      {/* Empty state */}
      {!currentClip && (
        <View style={styles.centerContent}>
          <Text style={styles.statusText}>No clip at playhead</Text>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    alignSelf: 'center',
    backgroundColor: '#0a0a0a',
    borderRadius: 0,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    position: 'relative',
    overflow: 'hidden',
    marginVertical: 12,
  },
  video: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },
  colorBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.15,
  },
  centerContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  captionText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: '#cbd5e1',
    textAlign: 'center',
    lineHeight: 17,
  },
  statusText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  errorIcon: {
    fontSize: 20,
    color: colors.coral,
    fontWeight: '700',
    marginBottom: 6,
  },
  errorText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.coral,
    textAlign: 'center',
    marginBottom: 6,
  },
  uriText: {
    fontFamily: fonts.mono,
    fontSize: 7,
    color: colors.textDimmer,
    textAlign: 'center',
  },
  filterOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
  },
  filterTint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  textOverlayWrap: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    left: 8,
    right: 8,
    justifyContent: 'flex-end',
    alignItems: 'center',
    zIndex: 5,
  },
});

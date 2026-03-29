import { useRef, useEffect, useState, useCallback } from 'react';
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
  const hasAdjustment = b !== 100 || c !== 100 || s !== 100;
  const brightnessDelta = (b - 100) / 100;
  const contrastDelta = (c - 100) / 100;
  const desatAmount = s < 100 ? (100 - s) / 100 : 0;

  return (
    <View style={styles.filterOverlay} pointerEvents="none">
      {brightnessDelta > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#fff', opacity: brightnessDelta * 0.5 }]} />
      )}
      {brightnessDelta < 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#000', opacity: Math.abs(brightnessDelta) * 0.6 }]} />
      )}
      {contrastDelta < 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#808080', opacity: Math.abs(contrastDelta) * 0.35 }]} />
      )}
      {contrastDelta > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#000', opacity: contrastDelta * 0.2 }]} />
      )}
      {desatAmount > 0 && (
        <View style={[styles.filterTint, { backgroundColor: '#808080', opacity: desatAmount * 0.45 }]} />
      )}
      {hasAdjustment && filterPreset && (
        <View style={styles.filterBadge}>
          <Text style={[styles.filterBadgeText, { color: filterPreset.color }]}>
            {b !== 100 ? `B:${b}` : ''}{c !== 100 ? ` C:${c}` : ''}{s !== 100 ? ` S:${s}` : ''}
          </Text>
        </View>
      )}
    </View>
  );
}

type Props = {
  currentClip: ClipItem | null;
  currentClipSeekSec: number;
  isPlaying: boolean;
  visibleTexts: TextOverlay[];
  visibleFilter: FilterOverlay | null;
  selectedTextId: string | null;
  focusTextInput?: boolean;
  onSelectText: (id: string) => void;
  onUpdateText?: (id: string, text: string) => void;
  previewHeight?: number;
};

export function PreviewPlayer({
  currentClip,
  currentClipSeekSec,
  isPlaying,
  visibleTexts,
  visibleFilter,
  selectedTextId,
  onSelectText,
  focusTextInput = false,
  onUpdateText,
  previewHeight = 320,
}: Props) {
  const videoRef = useRef<VideoRef>(null);
  const filterPreset = visibleFilter ? FILTERS.find(f => f.id === visibleFilter.filterId) : null;
  const [videoStatus, setVideoStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSeekClipId, setLastSeekClipId] = useState<string | null>(null);

  const hasClipUri = !!(currentClip?.clipUri && currentClip.clipUri.length > 0);
  const [fileExists, setFileExists] = useState(false);
  const hasVideo = hasClipUri && fileExists;

  // Check file exists before mounting Video (prevents native crash on bad URIs)
  useEffect(() => {
    if (!hasClipUri || !currentClip?.clipUri) {
      setFileExists(false);
      return;
    }
    try {
      const uri = currentClip.clipUri;
      // Trust content:// URIs (from system)
      if (uri.startsWith('content://')) {
        setFileExists(true);
        return;
      }
      // Bare filenames (no path separator) are invalid — happens after Notion sync
      if (!uri.includes('/')) {
        setFileExists(false);
        return;
      }
      const file = new FSFile(uri.startsWith('file://') ? uri : `file://${uri}`);
      setFileExists(file.exists);
    } catch {
      setFileExists(false);
    }
  }, [currentClip?.clipUri, hasClipUri]);

  // Reset when clip changes
  useEffect(() => {
    if (currentClip?.id !== lastSeekClipId) {
      setVideoStatus(hasVideo ? 'loading' : 'idle');
      setErrorMsg('');
      setLastSeekClipId(currentClip?.id ?? null);
    }
  }, [currentClip?.id, hasVideo]);

  const handleLoad = useCallback((data: OnLoadData) => {
    setVideoStatus('ready');
    if (videoRef.current && currentClipSeekSec > 0) {
      videoRef.current.seek(currentClipSeekSec);
    }
  }, [currentClipSeekSec]);

  const handleError = useCallback((e: OnVideoErrorData) => {
    const msg = e?.error?.errorString
      ?? e?.error?.errorException
      ?? e?.error?.error
      ?? 'Unknown error';
    setVideoStatus('error');
    setErrorMsg(msg);
  }, []);

  // Seek on scrub while paused
  useEffect(() => {
    if (videoRef.current && videoStatus === 'ready' && !isPlaying) {
      videoRef.current.seek(currentClipSeekSec);
    }
  }, [currentClipSeekSec, isPlaying, videoStatus]);

  const previewWidth = Math.round(previewHeight * 9 / 16);

  return (
    <View style={[styles.preview, { width: previewWidth, height: previewHeight }]}>
      {/* Actual video player */}
      {hasVideo && videoStatus !== 'error' && (
        <Video
          key={currentClip.id}
          ref={videoRef}
          source={{ uri: currentClip.clipUri }}
          style={styles.video}
          resizeMode="cover"
          paused={!isPlaying}
          repeat={false}
          muted={false}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}

      {/* Fallback for clips with no video file */}
      {currentClip && !hasVideo && (
        <>
          <View style={[styles.colorBg, { backgroundColor: currentClip.color }]} />
          <View style={styles.centerContent}>
            <Icon name="video" size={24} color={colors.textDim} />
            <Text style={styles.captionText} numberOfLines={3}>
              {hasClipUri && !fileExists ? 'File missing' : currentClip.caption}
            </Text>
          </View>
        </>
      )}

      {/* Loading state */}
      {hasVideo && videoStatus === 'loading' && (
        <View style={styles.centerContent}>
          <Text style={styles.statusText}>Loading...</Text>
        </View>
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
                  fontFamily: t.fontWeight >= 700 ? 'PoppinsBold' : 'Poppins',
                  fontSize: scaledSize,
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
                fontFamily: t.fontWeight >= 700 ? 'PoppinsBold' : 'Poppins',
                fontSize: scaledSize,
                color: t.color,
                textAlign: align,
                borderWidth: 0,
                paddingHorizontal: 6,
                borderRadius: 3,
                textShadowColor: 'rgba(0,0,0,0.7)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 4,
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

      {/* Debug: show URI at bottom */}
      {currentClip && (
        <View style={styles.debugBar}>
          <Text style={styles.debugText} numberOfLines={1}>
            {hasVideo ? currentClip.clipUri.slice(-30) : 'no file'}
          </Text>
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
  noVideoIcon: {
    fontSize: 24,
    marginBottom: 8,
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
  filterBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  filterBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 7,
    letterSpacing: 0.6,
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
  debugBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 4,
    paddingVertical: 2,
    zIndex: 10,
  },
  debugText: {
    fontFamily: fonts.mono,
    fontSize: 6,
    color: colors.textDimmer,
    textAlign: 'center',
  },
});

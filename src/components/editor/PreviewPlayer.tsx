import { useRef, useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Video, { type VideoRef, type OnLoadData, type OnVideoErrorData } from 'react-native-video';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { FILTERS } from '../../constants/filters';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../types/project';

type Props = {
  currentClip: ClipItem | null;
  currentClipSeekSec: number;
  isPlaying: boolean;
  visibleTexts: TextOverlay[];
  visibleFilter: FilterOverlay | null;
  selectedTextId: string | null;
  onSelectText: (id: string) => void;
};

export function PreviewPlayer({
  currentClip,
  currentClipSeekSec,
  isPlaying,
  visibleTexts,
  visibleFilter,
  selectedTextId,
  onSelectText,
}: Props) {
  const videoRef = useRef<VideoRef>(null);
  const filterPreset = visibleFilter ? FILTERS.find(f => f.id === visibleFilter.filterId) : null;
  const [videoStatus, setVideoStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSeekClipId, setLastSeekClipId] = useState<string | null>(null);

  const hasVideo = !!(currentClip?.clipUri && currentClip.clipUri.length > 0);

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

  return (
    <View style={styles.preview}>
      {/* Actual video player */}
      {hasVideo && (
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
            <Text style={styles.captionText} numberOfLines={3}>{currentClip.caption}</Text>
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

      {/* Filter overlay */}
      {visibleFilter && filterPreset && (
        <View style={styles.filterOverlay}>
          <View style={[styles.filterTint, { backgroundColor: filterPreset.color }]} />
          <View style={styles.filterBadge}>
            <Text style={[styles.filterBadgeText, { color: filterPreset.color }]}>
              {filterPreset.label.toUpperCase()}
            </Text>
          </View>
        </View>
      )}

      {/* Text overlays */}
      {visibleTexts.map(t => {
        const scaledSize = Math.max(10, Math.round(t.fontSize * 0.55));
        return (
          <Pressable
            key={t.id}
            onPress={() => onSelectText(t.id)}
            style={styles.textOverlayWrap}
          >
            <Text style={{
              fontFamily: fonts.heading,
              fontSize: scaledSize,
              fontWeight: String(t.fontWeight) as '300' | '400' | '700',
              color: t.color,
              textAlign: 'center',
              borderWidth: selectedTextId === t.id ? 1 : 0,
              borderColor: 'rgba(255,255,255,0.4)',
              borderStyle: 'dashed',
              paddingHorizontal: 6,
              borderRadius: 3,
              textShadowColor: 'rgba(0,0,0,0.7)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 4,
            }}>
              {t.text}
            </Text>
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
    width: 180,
    height: 320,
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
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
    opacity: 0.2,
    pointerEvents: 'none',
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
    bottom: 28,
    left: 8,
    right: 8,
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

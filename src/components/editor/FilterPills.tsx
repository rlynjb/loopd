import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Image, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';

type Props = {
  activeFilterId: string;
  onSelect: (filterId: string) => void;
  previewClipUri?: string;
  previewClipTrimStartMs?: number;
};

// Apply the filter's BCS + tint as a stack of overlay views on top of the thumbnail.
// Mirrors the FilterPreview used in the video preview so tiles match the live look.
function TileFilterOverlay({ filter }: { filter: typeof FILTERS[number] }) {
  const brightnessDelta = (filter.brightness - 100) / 100;
  const contrastDelta = (filter.contrast - 100) / 100;
  const desatAmount = filter.saturate < 100 ? (100 - filter.saturate) / 100 : 0;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {brightnessDelta > 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: Math.min(0.35, brightnessDelta * 0.4) }]} />
      )}
      {brightnessDelta < 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: Math.min(0.4, Math.abs(brightnessDelta) * 0.5) }]} />
      )}
      {contrastDelta > 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: Math.min(0.15, contrastDelta * 0.15) }]} />
      )}
      {contrastDelta < 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#808080', opacity: Math.min(0.25, Math.abs(contrastDelta) * 0.3) }]} />
      )}
      {desatAmount > 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#808080', opacity: Math.min(0.55, desatAmount * 0.55) }]} />
      )}
      {filter.tint && filter.tintOpacity > 0 && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: filter.tint, opacity: filter.tintOpacity }]} />
      )}
    </View>
  );
}

function usePreviewThumb(clipUri: string | undefined, trimStartMs: number): string | null {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    if (!clipUri) { setUri(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const timeMs = Math.max(100, Math.round(trimStartMs));
        const { uri } = await VideoThumbnails.getThumbnailAsync(clipUri, { time: timeMs, quality: 0.4 });
        if (!cancelled) setUri(uri);
      } catch {
        if (!cancelled) setUri(null);
      }
    })();
    return () => { cancelled = true; };
  }, [clipUri, trimStartMs]);

  return uri;
}

export function FilterPills({ activeFilterId, onSelect, previewClipUri, previewClipTrimStartMs = 0 }: Props) {
  const thumbUri = usePreviewThumb(previewClipUri, previewClipTrimStartMs);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.container}>
      {FILTERS.map(f => {
        const isActive = activeFilterId === f.id;
        return (
          <Pressable
            key={f.id}
            onPress={() => onSelect(f.id)}
            style={styles.tileWrap}
          >
            <View
              style={[
                styles.tile,
                isActive && { borderColor: f.color, borderWidth: 2 },
              ]}
            >
              {thumbUri ? (
                <Image source={{ uri: thumbUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: `${f.color}25` }]} />
              )}
              {f.id !== 'none' && <TileFilterOverlay filter={f} />}
            </View>
            <Text style={[styles.label, { color: isActive ? f.color : colors.textMuted }]}>
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const TILE_SIZE = 64;

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  tileWrap: {
    alignItems: 'center',
    gap: 6,
  },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.3,
  },
});

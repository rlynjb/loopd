import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../types/project';
import { formatDuration } from '../../utils/time';

type Props = {
  currentClip: ClipItem | null;
  visibleTexts: TextOverlay[];
  visibleFilter: FilterOverlay | null;
  selectedTextId: string | null;
  onSelectText: (id: string) => void;
};

export function PreviewPlayer({ currentClip, visibleTexts, visibleFilter, selectedTextId, onSelectText }: Props) {
  const filterPreset = visibleFilter ? FILTERS.find(f => f.id === visibleFilter.filterId) : null;

  return (
    <View style={styles.preview}>
      {/* Filter tint */}
      {visibleFilter && filterPreset && (
        <View style={[styles.filterOverlay, { opacity: 0.15 }]}>
          <View style={[styles.filterGlow, { backgroundColor: filterPreset.color }]} />
        </View>
      )}

      {/* Clip color */}
      {currentClip && (
        <View style={[styles.clipGlow, { backgroundColor: currentClip.color }]} />
      )}

      {currentClip ? (
        <View style={styles.clipContent}>
          <Text style={styles.clipCaption} numberOfLines={3}>{currentClip.caption}</Text>
          <Text style={styles.clipDuration}>
            {formatDuration(Math.round((currentClip.durationMs / 1000) * (currentClip.trimEndPct - currentClip.trimStartPct) / 100))}
          </Text>
          {visibleFilter && filterPreset && (
            <View style={styles.filterBadge}>
              <Text style={[styles.filterBadgeText, { color: filterPreset.color }]}>
                {filterPreset.label.toUpperCase()}
              </Text>
            </View>
          )}
        </View>
      ) : null}

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
            }}>
              {t.text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    alignSelf: 'center',
    width: 135,
    height: 240,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    marginVertical: 12,
  },
  filterOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  filterGlow: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.3,
  },
  clipGlow: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.1,
  },
  clipContent: {
    zIndex: 1,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  clipCaption: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: '#cbd5e1',
    textAlign: 'center',
    lineHeight: 15,
    maxHeight: 48,
  },
  clipDuration: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    marginTop: 4,
  },
  filterBadge: {
    position: 'absolute',
    top: -80,
    right: -30,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
    bottom: 12,
    left: 8,
    right: 8,
    alignItems: 'center',
    zIndex: 5,
  },
});

import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import { Icon } from '../ui/Icon';
import type { FilterOverlay } from '../../types/project';

type Props = {
  overlay: FilterOverlay;
  onUpdate: (updates: Partial<FilterOverlay>) => void;
  onDelete: () => void;
};

export function FilterEditor({ overlay, onUpdate, onDelete }: Props) {
  return (
    <View style={styles.container}>
      {/* Preset picker */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetScroll}>
        {FILTERS.filter(f => f.id !== 'none').map(f => {
          const isActive = overlay.filterId === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => onUpdate({
                filterId: f.id,
                brightness: f.brightness,
                contrast: f.contrast,
                saturate: f.saturate,
              })}
              style={[styles.presetBtn, isActive && { borderColor: f.color, backgroundColor: `${f.color}20` }]}
            >
              <View style={[styles.presetDot, { backgroundColor: f.color }]} />
              <Text style={[styles.presetLabel, { color: isActive ? f.color : colors.textMuted }]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={() => onUpdate({ startPct: 0, endPct: 100 })}
          style={[styles.footerBtn, overlay.startPct === 0 && overlay.endPct === 100 && { borderColor: colors.purple, backgroundColor: 'rgba(167,139,250,0.12)' }]}
        >
          <Text style={[styles.footerBtnText, overlay.startPct === 0 && overlay.endPct === 100 && { color: colors.purple }]}>FULL</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onDelete} style={styles.deleteBtn}>
          <Icon name="trash" size={14} color={colors.coral} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(167,139,250,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.20)',
    borderRadius: 0,
    padding: 16,
    marginBottom: 14,
  },
  presetScroll: {
    marginBottom: 12,
    marginHorizontal: -4,
  },
  presetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 3,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  presetDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  presetLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  footerBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 7,
  },
  footerBtnText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.4,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

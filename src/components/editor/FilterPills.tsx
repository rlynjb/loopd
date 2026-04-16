import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';

type Props = {
  activeFilterId: string;
  onSelect: (filterId: string) => void;
};

export function FilterPills({ activeFilterId, onSelect }: Props) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.container}>
      {FILTERS.map(f => {
        const isActive = activeFilterId === f.id;
        return (
          <Pressable
            key={f.id}
            onPress={() => onSelect(f.id)}
            style={[styles.pill, isActive && { borderColor: f.color, backgroundColor: `${f.color}20` }]}
          >
            <View style={[styles.dot, { backgroundColor: f.color }]} />
            <Text style={[styles.label, { color: isActive ? f.color : colors.textMuted }]}>{f.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
});

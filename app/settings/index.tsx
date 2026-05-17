import { View, Text, Pressable, ScrollView, Alert, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';

export default function SettingsMenu() {
  const router = useRouter();

  const handleExportDb = async () => {
    try {
      const SQLite = await import('expo-sqlite');
      const Sharing = await import('expo-sharing');
      const db = await SQLite.openDatabaseAsync('buffr.db');
      const dbPath = (db as unknown as { databasePath: string }).databasePath;
      await (db as unknown as { closeAsync: () => Promise<void> }).closeAsync();
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(`file://${dbPath}`, {
          mimeType: 'application/x-sqlite3',
          dialogTitle: 'Export buffr database',
        });
      }
    } catch (err) {
      console.warn('[buffr] DB export failed:', err);
    }
  };

  const handleImportDb = async () => {
    Alert.alert(
      'Import Database',
      'This will replace ALL your current data. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Import',
          style: 'destructive',
          onPress: async () => {
            try {
              const DocumentPicker = await import('expo-document-picker');
              const SQLite = await import('expo-sqlite');
              const { File: FSFile } = await import('expo-file-system');
              const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
              if (result.canceled || !result.assets?.[0]) return;
              const pickedUri = result.assets[0].uri;

              const db = await SQLite.openDatabaseAsync('buffr.db');
              const dbPath = (db as unknown as { databasePath: string }).databasePath;
              await (db as unknown as { closeAsync: () => Promise<void> }).closeAsync();

              const src = new FSFile(pickedUri);
              const dest = new FSFile(`file://${dbPath}`);
              src.move(dest);

              Alert.alert('Import Complete', 'Restart the app to load the imported data.');
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              Alert.alert('Import Failed', msg);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        {/* Cloud Sync (Supabase) */}
        <Pressable onPress={() => router.push('/settings/cloud-sync')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="upload" size={18} color={colors.amber} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>Cloud Sync</Text>
            <Text style={styles.menuSub}>Supabase backup (Phase A — personal)</Text>
          </View>
        </Pressable>

        {/* AI Settings */}
        <Pressable onPress={() => router.push('/settings/ai')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="zap" size={18} color={colors.amber} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>AI Settings</Text>
            <Text style={styles.menuSub}>Claude API key for vlog auto-compose</Text>
          </View>
        </Pressable>

        {/* Export Database */}
        <Pressable onPress={handleExportDb} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="download" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>Export Database</Text>
            <Text style={styles.menuSub}>Share SQLite file to laptop</Text>
          </View>
        </Pressable>

        {/* Import Database */}
        <Pressable onPress={handleImportDb} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="upload" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>Import Database</Text>
            <Text style={styles.menuSub}>Restore from exported SQLite file</Text>
          </View>
        </Pressable>

        {/* App Updates */}
        <Pressable onPress={() => router.push('/settings/updates')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="zap" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>App Updates</Text>
            <Text style={styles.menuSub}>Check for new versions</Text>
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingBottom: 60,
    gap: 12,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radiusLg,
    padding: 16,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: `${colors.accent2}10`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuInfo: {
    flex: 1,
    gap: 2,
  },
  menuLabel: {
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  menuSub: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  menuDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

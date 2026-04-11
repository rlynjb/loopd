import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';

export default function NotionGuideScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Notion Setup</Text>

        <Step num="1" title="Create a Notion Integration">
          <Text style={styles.text}>
            Go to notion.so/my-integrations and click "New integration". Name it "loopd". Copy the integration token (starts with ntn_).
          </Text>
        </Step>

        <Step num="2" title="Create the Entries Database">
          <Text style={styles.text}>
            Create a new full-page Notion database. This is where your journal entries, clips, and habits sync. Add these columns:
          </Text>
          <Table rows={[
            ['Title', 'Title (default)'],
            ['Date', 'Date'],
            ['Text', 'Text (rich text)'],
            ['Habits', 'Multi-select'],
            ['Todos', 'Text (rich text)'],
            ['Clips', 'Text (rich text)'],
            ['loopd ID', 'Text (rich text)'],
            ['Created At', 'Date'],
          ]} />
          <Text style={styles.hint}>
            Todos and Clips store JSON data — don't edit them directly in Notion.
          </Text>
        </Step>

        <Step num="3" title="Share with Integration">
          <Text style={styles.text}>
            Open each database, click the "..." menu in the top right, select "Connections", search for "loopd", and click "Connect".
          </Text>
        </Step>

        <Step num="4" title="Copy Database IDs">
          <Text style={styles.text}>
            Open your database as a full page. The URL looks like:{'\n\n'}
            notion.so/workspace/{'<'}DATABASE_ID{'>'}?v=...{'\n\n'}
            Copy the part between the last / and the ? — that's the database ID.
          </Text>
        </Step>

        <Step num="5" title="Connect & Sync">
          <Text style={styles.text}>
            Go to Notion Sync in Settings, paste your token and database IDs, tap "Test connection", then "Sync Now".
          </Text>
        </Step>
      </ScrollView>
    </View>
  );
}

function Step({ num, title, children }: { num: string; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{num}</Text>
      </View>
      <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function Table({ rows }: { rows: [string, string][] }) {
  return (
    <View style={styles.table}>
      {rows.map(([col, type], i) => (
        <View key={i} style={styles.tableRow}>
          <Text style={styles.tableCol}>{col}</Text>
          <Text style={styles.tableType}>{type}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 20 },
  title: { fontFamily: fonts.heading, fontSize: 28, color: colors.text, letterSpacing: -0.5, marginBottom: 4 },
  step: { flexDirection: 'row', gap: 14 },
  stepNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: `${colors.accent2}15`, borderWidth: 1, borderColor: `${colors.accent2}30`, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { fontFamily: fonts.mono, fontSize: 11, color: colors.accent2 },
  stepContent: { flex: 1, gap: 8 },
  stepTitle: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.accent },
  text: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  hint: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, fontStyle: 'italic', lineHeight: 15 },
  table: { backgroundColor: colors.bg3, borderRadius: 8, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  tableCol: { fontFamily: fonts.mono, fontSize: 11, color: colors.text },
  tableType: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
});

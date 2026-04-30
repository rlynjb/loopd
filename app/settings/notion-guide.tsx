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

        <Step num="3" title="Create the Todos Database (optional)">
          <Text style={styles.text}>
            Create a second full-page Notion database if you want individual todos to sync as their own rows. Property names are case-sensitive:
          </Text>
          <Table rows={[
            ['Name', 'Title (default)'],
            ['Done', 'Checkbox'],
            ['loopd ID', 'Text (rich text)'],
            ['Created At', 'Date'],
            ['Entry Date', 'Date'],
            ['Type', 'Select'],
            ['Expanded', 'Text (rich text)'],
            ['Model', 'Select'],
            ['Confidence', 'Select'],
            ['User Overridden', 'Checkbox'],
          ]} />
          <Text style={styles.hint}>
            Type select options: todo, idea, bug, question, decision, knowledge, content. Confidence options: heuristic, high, medium, low. Don't edit Name in Notion — the loopd journal prose is the canonical source for todo text.
          </Text>
          <Text style={styles.hint}>
            Skip this step to keep todos embedded on their parent entry only.
          </Text>
        </Step>

        <Step num="4" title="Create the Nutrition Database (optional)">
          <Text style={styles.text}>
            Create a full-page Notion database if you want to sync nutrition entries. Each "** food N kcal" line in your journal becomes a row here. Property names are case-sensitive:
          </Text>
          <Table rows={[
            ['Name', 'Title (default)'],
            ['Kcal', 'Number'],
            ['Entry Date', 'Date'],
            ['loopd ID', 'Text (rich text)'],
            ['Created At', 'Date'],
          ]} />
          <Text style={styles.hint}>
            Skip this step to keep nutrition local-only.
          </Text>
        </Step>

        <Step num="5" title="Create the Habits Database (optional)">
          <Text style={styles.text}>
            Create a full-page Notion database if you want habit cadence and metadata to sync bidirectionally. Property names are case-sensitive:
          </Text>
          <Table rows={[
            ['Name', 'Title (default)'],
            ['loopd ID', 'Text (rich text)'],
            ['Slug', 'Text (rich text)'],
            ['Cadence Type', 'Select'],
            ['Cadence Days', 'Multi-select'],
            ['Cadence Count', 'Number'],
            ['Time of Day', 'Select'],
            ['Icon', 'Text (rich text)'],
            ['Color', 'Text (rich text)'],
          ]} />
          <Text style={styles.hint}>
            Cadence Type options: daily, weekdays, weekly, specific_days, n_per_week. Cadence Days (Mon, Tue, ..., Sun) only used for weekly and specific_days. Cadence Count is the N for n_per_week. Time of Day options: morning, midday, evening, anytime — drives dashboard ordering. The Habits multi-select on the Entries DB still governs habit identity — this DB carries the cadence + metadata.
          </Text>
        </Step>

        <Step num="6" title="Create the Threads Database (optional)">
          <Text style={styles.text}>
            Create a full-page Notion database to sync project threads bidirectionally. Mentions ("#tag" occurrences in entries/todos) are NOT synced — they're derived from prose, and the entries/todos already sync. Property names are case-sensitive:
          </Text>
          <Table rows={[
            ['Name', 'Title (default)'],
            ['loopd ID', 'Text (rich text)'],
            ['Slug', 'Text (rich text)'],
            ['Icon', 'Text (rich text)'],
            ['Color', 'Text (rich text)'],
            ['Target Cadence (days)', 'Number'],
            ['Archived', 'Checkbox'],
            ['Pinned', 'Checkbox'],
            ['Time of Day', 'Select'],
          ]} />
          <Text style={styles.hint}>
            Slug is local-only — editing it in Notion is rejected to preserve mention reconciliation. Rename slugs from the loopd Threads CRUD instead. Everything else (name, icon, color, target cadence, archived, pinned, time of day) syncs both ways. Time of Day options: morning, midday, evening, anytime — drives dashboard ordering.
          </Text>
        </Step>

        <Step num="7" title="Share with Integration">
          <Text style={styles.text}>
            Open each database, click the "..." menu in the top right, select "Connections", search for "loopd", and click "Connect".
          </Text>
        </Step>

        <Step num="8" title="Copy Database IDs">
          <Text style={styles.text}>
            Open your database as a full page. The URL looks like:{'\n\n'}
            notion.so/workspace/{'<'}DATABASE_ID{'>'}?v=...{'\n\n'}
            Copy the part between the last / and the ? — that's the database ID.
          </Text>
        </Step>

        <Step num="9" title="Connect & Sync">
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

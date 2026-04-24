import { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { TextInput, StyleSheet, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type Selection = { start: number; end: number };

type Props = {
  initialValue?: string;
  onSave: (text: string) => void;
  onSilentSave?: (text: string) => void;
  onCancel: () => void;
  onAutoCommit?: () => void;
  liveTextRef?: React.MutableRefObject<string>;
  // Fired whenever the cursor moves or the text changes. Lets the parent
  // implement autocomplete (e.g. detect a "** " prefix on the current line).
  onCursorChange?: (state: { text: string; selection: Selection }) => void;
};

// Imperative handle used by the journal screen:
// - appendText: keyboard toolbar "Todo" button inserts "[] " at end of prose
// - replaceRange: autocomplete chip tap replaces [start, end) with the chip's
//   canonical string and places the cursor right after it
export type InlineTextInputHandle = {
  appendText: (text: string) => void;
  replaceRange: (start: number, end: number, replacement: string) => void;
};

export const InlineTextInput = memo(forwardRef<InlineTextInputHandle, Props>(function InlineTextInput(
  { initialValue = '', onSave, onSilentSave, onCancel, onAutoCommit, liveTextRef, onCursorChange },
  ref,
) {
  const [text, setText] = useState(initialValue);
  const [height, setHeight] = useState(18);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const pendingSelection = useRef<Selection | null>(null);
  const selectionRef = useRef<Selection>({ start: initialValue.length, end: initialValue.length });
  const textRef = useRef(text);
  const inputRef = useRef<TextInput>(null);
  const onSaveRef = useRef(onSave);
  const onSilentSaveRef = useRef(onSilentSave);
  const onCancelRef = useRef(onCancel);
  const onAutoCommitRef = useRef(onAutoCommit);
  const onCursorChangeRef = useRef(onCursorChange);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  onSaveRef.current = onSave;
  onSilentSaveRef.current = onSilentSave;
  onCancelRef.current = onCancel;
  onAutoCommitRef.current = onAutoCommit;
  onCursorChangeRef.current = onCursorChange;

  const emitCursor = useCallback((nextText: string, nextSel: Selection) => {
    onCursorChangeRef.current?.({ text: nextText, selection: nextSel });
  }, []);

  const applyText = useCallback((next: string, nextCursor?: number) => {
    setText(next);
    textRef.current = next;
    if (liveTextRef) liveTextRef.current = next;
    if (onSilentSaveRef.current) onSilentSaveRef.current(next.trim());
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { onAutoCommitRef.current?.(); }, 20000);

    const cursor = nextCursor != null ? nextCursor : (selectionRef.current.start ?? next.length);
    const sel: Selection = { start: cursor, end: cursor };
    selectionRef.current = sel;
    if (nextCursor != null) {
      pendingSelection.current = sel;
      setSelection(sel);
    }
    emitCursor(next, sel);
  }, [emitCursor, liveTextRef]);

  const handleChange = useCallback((newText: string) => {
    applyText(newText);
  }, [applyText]);

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const sel = e.nativeEvent.selection;
      selectionRef.current = sel;
      // Clear the one-shot selection override as soon as RN applies it, so
      // subsequent user taps can move the cursor freely.
      if (pendingSelection.current
        && pendingSelection.current.start === sel.start
        && pendingSelection.current.end === sel.end) {
        pendingSelection.current = null;
        setSelection(undefined);
      }
      emitCursor(textRef.current, sel);
    },
    [emitCursor],
  );

  // Start idle timer on mount (handles empty entries)
  useEffect(() => {
    if (onAutoCommitRef.current) {
      idleTimer.current = setTimeout(() => {
        onAutoCommitRef.current?.();
      }, 20000);
    }
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, []);

  useImperativeHandle(ref, () => ({
    appendText: (append: string) => {
      const current = textRef.current;
      const needsBreak = current.length > 0 && !current.endsWith('\n');
      const next = current + (needsBreak ? '\n' : '') + append;
      applyText(next, next.length);
      inputRef.current?.focus();
    },
    replaceRange: (start: number, end: number, replacement: string) => {
      const current = textRef.current;
      const s = Math.max(0, Math.min(start, current.length));
      const e = Math.max(s, Math.min(end, current.length));
      const next = current.slice(0, s) + replacement + current.slice(e);
      applyText(next, s + replacement.length);
      inputRef.current?.focus();
    },
  }), [applyText]);

  const handleBlur = useCallback(() => {
    // Save handled by parent via liveTextRef
  }, []);

  return (
    <TextInput
      ref={inputRef}
      value={text}
      selection={selection}
      onChangeText={handleChange}
      onSelectionChange={handleSelectionChange}
      onBlur={handleBlur}
      onContentSizeChange={e => setHeight(Math.max(18, e.nativeEvent.contentSize.height))}
      placeholder="Write something..."
      placeholderTextColor={colors.textDimmer}
      autoFocus
      multiline
      blurOnSubmit={false}
      style={[styles.input, { height }]}
    />
  );
}));

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
    padding: 0,
    margin: 0,
  },
});

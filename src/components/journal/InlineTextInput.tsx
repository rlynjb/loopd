import { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type Props = {
  initialValue?: string;
  onSave: (text: string) => void;
  onSilentSave?: (text: string) => void;
  onCancel: () => void;
  onAutoCommit?: () => void;
  liveTextRef?: React.MutableRefObject<string>;
};

// Imperative handle used by the journal screen so the keyboard toolbar's Todo
// button can inject `[] ` into the currently-focused input without going
// through state round-trips.
export type InlineTextInputHandle = {
  appendText: (text: string) => void;
};

export const InlineTextInput = memo(forwardRef<InlineTextInputHandle, Props>(function InlineTextInput(
  { initialValue = '', onSave, onSilentSave, onCancel, onAutoCommit, liveTextRef },
  ref,
) {
  const [text, setText] = useState(initialValue);
  const [height, setHeight] = useState(18);
  const textRef = useRef(text);
  const inputRef = useRef<TextInput>(null);
  const onSaveRef = useRef(onSave);
  const onSilentSaveRef = useRef(onSilentSave);
  const onCancelRef = useRef(onCancel);
  const onAutoCommitRef = useRef(onAutoCommit);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  onSaveRef.current = onSave;
  onSilentSaveRef.current = onSilentSave;
  onCancelRef.current = onCancel;
  onAutoCommitRef.current = onAutoCommit;

  const applyText = useCallback((next: string) => {
    setText(next);
    textRef.current = next;
    if (liveTextRef) liveTextRef.current = next;
    if (onSilentSaveRef.current) onSilentSaveRef.current(next.trim());
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { onAutoCommitRef.current?.(); }, 20000);
  }, [liveTextRef]);

  const handleChange = useCallback((newText: string) => {
    applyText(newText);
  }, [applyText]);

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
      // Ensure the appended block starts on its own line so a mid-sentence
      // Todo tap doesn't create "... something[] foo".
      const needsBreak = current.length > 0 && !current.endsWith('\n');
      const next = current + (needsBreak ? '\n' : '') + append;
      applyText(next);
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
      onChangeText={handleChange}
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

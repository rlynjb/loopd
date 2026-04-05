import { useRef, useState, useCallback, useEffect, memo } from 'react';
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

export const InlineTextInput = memo(function InlineTextInput({ initialValue = '', onSave, onSilentSave, onCancel, onAutoCommit, liveTextRef }: Props) {
  const [text, setText] = useState(initialValue);
  const [height, setHeight] = useState(18);
  const textRef = useRef(text);
  const onSaveRef = useRef(onSave);
  const onSilentSaveRef = useRef(onSilentSave);
  const onCancelRef = useRef(onCancel);
  const onAutoCommitRef = useRef(onAutoCommit);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  onSaveRef.current = onSave;
  onSilentSaveRef.current = onSilentSave;
  onCancelRef.current = onCancel;
  onAutoCommitRef.current = onAutoCommit;
  onAutoCommitRef.current = onAutoCommit;

  const handleChange = useCallback((newText: string) => {
    setText(newText);
    textRef.current = newText;
    if (liveTextRef) liveTextRef.current = newText;

    // Save to DB immediately on every keystroke (DB only, no re-render)
    if (onSilentSaveRef.current) {
      onSilentSaveRef.current(newText.trim());
    }

    // Auto-commit after 5 seconds of inactivity
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      onAutoCommitRef.current?.();
    }, 20000);
  }, []);

  // Start idle timer on mount (handles empty entries)
  useEffect(() => {
    if (onAutoCommitRef.current) {
      idleTimer.current = setTimeout(() => {
        onAutoCommitRef.current?.();
      }, 20000);
    }
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, []);

  const handleBlur = useCallback(() => {
    // Save handled by parent via liveTextRef
  }, []);

  return (
    <TextInput
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
});

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

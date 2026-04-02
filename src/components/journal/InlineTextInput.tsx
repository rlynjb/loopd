import { useRef, useState, useCallback, useEffect, memo } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type Props = {
  initialValue?: string;
  onSave: (text: string) => void;
  onSilentSave?: (text: string) => void;
  onCancel: () => void;
  liveTextRef?: React.MutableRefObject<string>;
};

export const InlineTextInput = memo(function InlineTextInput({ initialValue = '', onSave, onSilentSave, onCancel, liveTextRef }: Props) {
  const [text, setText] = useState(initialValue);
  const [height, setHeight] = useState(18);
  const textRef = useRef(text);
  const onSaveRef = useRef(onSave);
  const onSilentSaveRef = useRef(onSilentSave);
  const onCancelRef = useRef(onCancel);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onSaveRef.current = onSave;
  onSilentSaveRef.current = onSilentSave;
  onCancelRef.current = onCancel;

  const handleChange = useCallback((newText: string) => {
    setText(newText);
    textRef.current = newText;
    if (liveTextRef) liveTextRef.current = newText;

    // Debounce silent save — DB only, no re-render
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (newText.trim() && onSilentSaveRef.current) {
        onSilentSaveRef.current(newText.trim());
      }
    }, 800);
  }, []);

  const handleBlur = useCallback(() => {
    // Save handled by parent's dismissAll via liveTextRef — no action needed here
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
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

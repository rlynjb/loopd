import { useRef, useState, useCallback, memo } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type Props = {
  initialValue?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
};

export const InlineTextInput = memo(function InlineTextInput({ initialValue = '', onSave, onCancel }: Props) {
  const [text, setText] = useState(initialValue);
  const [height, setHeight] = useState(18);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleChange = useCallback((newText: string) => {
    setText(newText);
  }, []);

  const handleBlur = () => {
    if (text.trim()) {
      onSaveRef.current(text.trim());
    } else {
      onCancel();
    }
  };

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

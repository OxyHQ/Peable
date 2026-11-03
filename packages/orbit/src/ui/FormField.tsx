import { View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { TextField, TextFieldHint, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';

/** A labelled Bloom text field with an optional hint, the one input every Orbit form uses. */
export function FormField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  disabled,
  invalid,
  secure,
  multiline,
  autoCapitalize = 'none',
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  secure?: boolean;
  multiline?: boolean;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  keyboardType?: TextInputProps['keyboardType'];
}) {
  return (
    <View className="gap-1.5">
      <TextFieldLabel>{label}</TextFieldLabel>
      <TextField isInvalid={invalid} disabled={disabled}>
        <TextFieldInput
          label={label}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          secureTextEntry={secure}
          revealable={secure}
          multiline={multiline}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          keyboardType={keyboardType}
        />
      </TextField>
      {hint ? <TextFieldHint isInvalid={invalid}>{hint}</TextFieldHint> : null}
    </View>
  );
}

import { View } from 'react-native';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { Text } from '@oxy.so/bloom/typography';

export interface ChoiceOption {
  value: string;
  label: string;
}

/** A labelled Bloom select over plain `{value, label}` options. */
export function Choice({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  size,
}: {
  label: string;
  value: string | null;
  options: readonly ChoiceOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <View className="gap-1.5">
      <Text variant="caption-1-medium" className="text-muted-foreground">
        {label}
      </Text>
      <Select value={value ?? undefined} onValueChange={onChange} disabled={disabled} size={size}>
        <SelectTrigger label={label}>
          <SelectValue placeholder={placeholder ?? label} />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent<ChoiceOption>
          label={label}
          items={options}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemIndicator />
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}

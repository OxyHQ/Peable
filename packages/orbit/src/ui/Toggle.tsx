import { View } from 'react-native';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';

/** A Bloom switch with its label and an optional hint, the one on/off control Orbit forms use. */
export function Toggle({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4 py-1">
      <View className="flex-1 gap-0.5">
        <Text variant="body-2-medium">{label}</Text>
        {hint ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  );
}

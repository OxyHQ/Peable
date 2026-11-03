import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button } from '@oxy.so/bloom/button';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oxy.so/bloom/tooltip';
import { Text } from '@oxy.so/bloom/typography';
import { formatInstant, formatRelative, formatShortInstant, nowSeconds } from '../format/time';
import { t } from '../i18n';

/**
 * The small pieces Stripe's tables and detail pages are made of: a whole row
 * that opens its object, a date that shows the full instant on hover, an id
 * that copies, an amount that lines up on the right.
 */

/**
 * A table row that opens its object — the whole row, as Stripe's do, not a
 * link inside one cell. Wraps Bloom's `TableRow` (which takes no press).
 */
export function RowLink({
  onPress,
  accessibilityLabel,
  children,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
        backgroundColor: pressed || hovered ? theme.colors.backgroundSecondary : undefined,
        cursor: 'pointer',
      })}
    >
      {children}
    </Pressable>
  );
}

/** A hover label over any content (web pointer; a long press elsewhere). */
export function HoverLabel({ label, children }: { label: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <Tooltip visible={visible} onVisibleChange={setVisible} position="top">
      <TooltipTrigger>
        <Pressable
          onHoverIn={() => setVisible(true)}
          onHoverOut={() => setVisible(false)}
          onLongPress={() => setVisible(true)}
          accessibilityHint={label}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent label={label}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A date as a table shows it — short, in the active language — with the full
 * instant and how long ago it was on hover.
 */
export function Timestamp({
  seconds,
  muted,
}: {
  seconds: number | null | undefined;
  muted?: boolean;
}) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return <Text variant="body-2-regular">—</Text>;
  }
  return (
    <HoverLabel label={`${formatInstant(seconds)} · ${formatRelative(seconds, nowSeconds())}`}>
      <Text variant="body-2-regular" className={muted ? 'text-muted-foreground' : undefined}>
        {formatShortInstant(seconds)}
      </Text>
    </HoverLabel>
  );
}

/** An object id in monospace that copies on press, with a toast saying so. */
export function CopyableId({ id, label }: { id: string; label?: string }) {
  const copy = () =>
    void Clipboard.setStringAsync(id).then(
      () => toast.success(t('state.copied')),
      () => undefined,
    );
  return (
    <View className="flex-row items-center gap-1">
      <Text variant="body-2-regular" selectable className="font-mono">
        {id}
      </Text>
      <Button
        appearance="plain"
        size="xs"
        iconOnly
        icon={RiFileCopyLine}
        accessibilityLabel={t('state.copy', { label: label ?? id })}
        onPress={copy}
      />
    </View>
  );
}

/** An amount in a table cell: tabular figures, so a column of them lines up. */
export function AmountText({ children, strong }: { children: string; strong?: boolean }) {
  return (
    <Text
      variant={strong ? 'body-2-semibold' : 'body-2-regular'}
      selectable
      style={{ fontVariant: ['tabular-nums'], textAlign: 'right' }}
    >
      {children}
    </Text>
  );
}

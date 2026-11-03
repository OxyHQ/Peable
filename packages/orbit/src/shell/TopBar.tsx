import { useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { AppShellMenuButton, NotificationBell } from '@oxy.so/bloom/app-shell';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { Kbd } from '@oxy.so/bloom/kbd';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '../i18n';
import { environmentForMode, modeForEnvironment } from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';
import { isCompactTopBar } from './layout';
import { modifierLabel } from './shortcuts';

const MOD = modifierLabel(
  Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.platform : Platform.OS,
);

/**
 * The bar over every page, Stripe's: the drawer's menu button on a phone, the
 * search over the application's objects (`SearchDialog`), then Test mode,
 * help and notifications at the end edge.
 */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const { width } = useWindowDimensions();
  const compact = isCompactTopBar(width);
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-3 py-2 md:px-6">
      <AppShellMenuButton accessibilityLabel={t('shell.sidebar.open')} />
      <View className="flex-1 min-w-0 max-w-lg">
        <Button
          appearance="subtle"
          tone="neutral"
          size="sm"
          leadingIcon={RiSearchLine}
          accessibilityLabel={t('shell.search.label')}
          onPress={onSearch}
          style={{ justifyContent: 'flex-start' }}
          numberOfLines={1}
          trailing={
            compact || Platform.OS !== 'web' ? undefined : (
              <View className="ml-auto">
                <Kbd size="sm">/</Kbd>
              </View>
            )
          }
        >
          {compact ? t('shell.search.placeholder') : t('search.placeholder')}
        </Button>
      </View>
      <View className="flex-1" />
      <TestModeSwitch compact={compact} />
      <Button
        appearance="plain"
        tone="neutral"
        size="sm"
        iconOnly
        leadingIcon={RiQuestionLine}
        accessibilityLabel={t('shell.help')}
        onPress={() => setHelpOpen(true)}
      />
      <NotificationBell notifications={[]} accessibilityLabel={t('shell.notifications')} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </View>
  );
}

/** Stripe's switch: on is test data, and it says so beside the toggle. */
function TestModeSwitch({ compact }: { compact: boolean }) {
  const scope = useOrbitScope();
  const test = modeForEnvironment(scope.environment) === 'test';
  return (
    <View className="flex-row items-center gap-2">
      {compact ? null : (
        <Text
          variant="body-2-medium"
          className={test ? 'text-warning-text' : 'text-muted-foreground'}
        >
          {t('shell.testMode')}
        </Text>
      )}
      <Switch
        size="sm"
        tone="warning"
        checked={test}
        onCheckedChange={(next) => scope.setEnvironment(environmentForMode(next ? 'test' : 'live'))}
        accessibilityLabel={t('shell.testMode')}
      />
    </View>
  );
}

/**
 * The full-width strip across the top of the window while in test mode, so
 * test data never passes for live data — whatever the page.
 */
export function TestModeStrip() {
  return (
    <View
      className="items-center justify-center bg-warning px-4 py-1"
      accessibilityRole="alert"
      accessibilityLabel={t('shell.testMode.strip')}
    >
      <Text variant="caption-1-semibold" className="text-warning-foreground text-center">
        {t('shell.testMode.strip')}
      </Text>
    </View>
  );
}

const SHORTCUTS: ReadonlyArray<{ keys: string[]; labelKey: string }> = [
  { keys: [MOD, 'K'], labelKey: 'shell.help.palette' },
  { keys: ['/'], labelKey: 'shell.help.slash' },
  { keys: [MOD, '\\'], labelKey: 'shell.help.sidebar' },
];

function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('shell.help.title')}
      maxWidth={440}
      actions={[{ label: t('shell.help.close'), onPress: onClose }]}
    >
      <View className="gap-3">
        {SHORTCUTS.map((shortcut) => (
          <View key={shortcut.labelKey} className="flex-row items-center justify-between gap-4">
            <Text variant="body-2-regular">{t(shortcut.labelKey)}</Text>
            <View className="flex-row gap-1">
              {shortcut.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </View>
          </View>
        ))}
      </View>
    </Dialog>
  );
}

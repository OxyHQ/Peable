/**
 * AskAlia — the header button that opens Alia's chat sheet.
 *
 * Alia is the Oxy assistant (`@alia.onl/sdk`). The sheet mounts only for a
 * signed-in person, because it talks to Alia on their account; a signed-out
 * press opens the Oxy sign-in instead. `screen` says what the person is
 * looking at, so Alia answers about that and not about wallets in general.
 */

import { useCallback, useMemo, useRef } from 'react';
import { Pressable } from 'react-native';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services';
import { t } from '../../i18n';

interface AskAliaProps {
  /** What the person is looking at, as a short phrase (already translated). */
  screen: string;
}

export function AskAlia({ screen }: AskAliaProps) {
  const theme = useTheme();
  const { isAuthenticated, signIn } = useAuth();
  const chatRef = useRef<AliaChatSheetRef>(null);

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'fairCoin', text: t('alia.suggestion.fairCoin') },
      { id: 'safety', text: t('alia.suggestion.safety') },
      { id: 'merchants', text: t('alia.suggestion.merchants') },
    ],
    [],
  );

  const handlePress = useCallback(() => {
    if (!isAuthenticated) {
      void signIn();
      return;
    }
    chatRef.current?.present();
  }, [isAuthenticated, signIn]);

  return (
    <>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t('alia.ask')}
        className="active:opacity-60"
        hitSlop={8}
      >
        <AliaAvatarIcon width={24} height={24} fill={theme.colors.text} />
      </Pressable>
      {isAuthenticated && (
        <AliaChatSheet
          ref={chatRef}
          clientContext={t('alia.clientContext', { screen })}
          welcomeSuggestions={welcomeSuggestions}
        />
      )}
    </>
  );
}

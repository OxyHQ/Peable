/**
 * Send screen.
 *
 * Thin route wrapper: the entire send UI + logic lives in {@link SendSheet} so
 * the same body can be shown inside a Bloom bottom-sheet on the home screen.
 * Here it renders as a full screen — safe-area top, horizontal padding, and its
 * own scroll — and forwards the deep-link params into the sheet content so they
 * prefill the form: `address` / `amount` from a `faircoin:` URI, or the whole
 * resolved recipient from the `/@username` profile page.
 */

import { View, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { SendSheet } from "../../src/ui/sheets/SendSheet";
import type { SocialRecipient } from "../../src/ui/components/SocialRecipientPicker";

export default function SendScreen() {
  const insets = useSafeAreaInsets();
  // Deep link params: `address` / `amount` from a `faircoin:` URI or QR scan,
  // and `recipientId` / `recipientUsername` / … from `/@username`, which
  // resolved the Oxy identity and reserved `address` before navigating here.
  const params = useLocalSearchParams<{
    address?: string;
    amount?: string;
    recipientId?: string;
    recipientUsername?: string;
    recipientDisplayName?: string;
    recipientAvatarFileId?: string;
  }>();

  // A recipient is only well-formed with both ids present; anything less is a
  // hand-edited URL and falls back to the plain address prefill rather than
  // rendering a nameless person card. The optional halves come through as ""
  // when the profile had none (expo-router drops undefined params, and an empty
  // avatar id would resolve to a broken image rather than the initial).
  const recipient: SocialRecipient | null =
    params.recipientId && params.recipientUsername
      ? {
          id: params.recipientId,
          username: params.recipientUsername,
          displayName: params.recipientDisplayName || undefined,
          avatarFileId: params.recipientAvatarFileId || undefined,
        }
      : null;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 16,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <SendSheet
          address={params.address}
          amount={params.amount}
          recipient={recipient}
        />
      </ScrollView>
    </View>
  );
}

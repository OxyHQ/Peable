/**
 * Recipient picker for "pay a person" (spec §4.4 step 1) — search Oxy users
 * by username/name and pick one. Mirrors `ContactPicker.tsx`'s Modal + search
 * + FlashList shape, backed by `oxyServices.searchProfiles` instead of the
 * local contacts database.
 */

import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Modal, ActivityIndicator } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@oxy.so/bloom/theme";
import { oxyServices } from "../../services/oxy-services";
import { UserAvatar } from "./UserAvatar";
import { t } from "../../i18n";

export interface SocialRecipient {
  id: string;
  username: string;
  displayName?: string;
  avatarFileId?: string;
}

interface SocialRecipientPickerProps {
  visible: boolean;
  onSelect: (recipient: SocialRecipient) => void;
  onClose: () => void;
}

/** Debounce delay before a keystroke triggers a search request. */
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const SEARCH_RESULT_LIMIT = 20;

function SocialRecipientRow({
  recipient,
  onPress,
}: {
  recipient: SocialRecipient;
  onPress: (recipient: SocialRecipient) => void;
}) {
  const handlePress = useCallback(() => {
    onPress(recipient);
  }, [recipient, onPress]);

  return (
    <Pressable
      className="flex-row items-center px-4 py-3 border-b border-border active:bg-background"
      onPress={handlePress}
    >
      <View className="mr-3">
        <UserAvatar
          avatarFileId={recipient.avatarFileId}
          displayName={recipient.displayName}
          username={recipient.username}
          size={40}
        />
      </View>
      <View className="flex-1">
        <Text className="text-foreground text-sm font-medium">
          {recipient.displayName ?? recipient.username}
        </Text>
        <Text className="text-muted-foreground text-xs mt-0.5">@{recipient.username}</Text>
      </View>
    </Pressable>
  );
}

export function SocialRecipientPicker({
  visible,
  onSelect,
  onClose,
}: SocialRecipientPickerProps) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ["oxyUserSearch", debouncedQuery],
    queryFn: async (): Promise<SocialRecipient[]> => {
      const response = await oxyServices.searchProfiles(debouncedQuery, {
        limit: SEARCH_RESULT_LIMIT,
      });
      return response.data.map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.name.displayName,
        avatarFileId: user.avatar ?? undefined,
      }));
    },
    enabled: debouncedQuery.length >= MIN_QUERY_LENGTH,
  });

  const results = data ?? [];

  const handleOpen = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
  }, []);

  const handleClose = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    onClose();
  }, [onClose]);

  const handleSelect = useCallback(
    (recipient: SocialRecipient) => {
      onSelect(recipient);
      handleClose();
    },
    [onSelect, handleClose],
  );

  const renderItem = useCallback(
    ({ item }: { item: SocialRecipient }) => (
      <SocialRecipientRow recipient={item} onPress={handleSelect} />
    ),
    [handleSelect],
  );

  const keyExtractor = useCallback((item: SocialRecipient) => item.id, []);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose} onShow={handleOpen}>
      <View className="flex-1 bg-background">
        <View className="pt-14 pb-3 px-6 flex-row items-center justify-between bg-background border-b border-border">
          <Text className="text-foreground text-lg font-bold">
            {t("socialRecipientPicker.title")}
          </Text>
          <Pressable onPress={handleClose} className="p-2">
            <Text className="text-primary text-base font-semibold">{t("common.close")}</Text>
          </Pressable>
        </View>

        <View className="px-4 py-3">
          <View className="bg-surface border border-border rounded-xl px-4 py-2.5">
            <TextInput
              className="text-foreground text-sm"
              placeholder={t("socialRecipientPicker.searchPlaceholder")}
              placeholderTextColor={theme.colors.textSecondary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        {isFetching ? (
          <View className="items-center py-8">
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : debouncedQuery.length < MIN_QUERY_LENGTH ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-muted-foreground text-base text-center">
              {t("socialRecipientPicker.prompt")}
            </Text>
          </View>
        ) : results.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-muted-foreground text-base text-center">
              {t("socialRecipientPicker.empty")}
            </Text>
          </View>
        ) : (
          <FlashList
            data={results}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            className="flex-1"
            contentContainerClassName="pb-8"
          />
        )}
      </View>
    </Modal>
  );
}

/**
 * Contact picker modal for selecting a contact's address.
 * Used in the Send screen to quickly fill an address from the address book.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, Modal } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useContactsStore } from "../../wallet/contacts-store";
import { getDatabase } from "../../wallet/wallet-store";
import type { ContactRow } from "../../storage/database";
import { useTheme } from "@oxyhq/bloom/theme";
import { ContactAvatar } from "./ContactAvatar";
import { t } from "../../i18n";

interface ContactPickerProps {
  visible: boolean;
  onSelect: (address: string) => void;
  onClose: () => void;
}

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function ContactPickerItem({
  contact,
  onPress,
}: {
  contact: ContactRow;
  onPress: (address: string) => void;
}) {
  const handlePress = useCallback(() => {
    onPress(contact.address);
  }, [contact.address, onPress]);

  return (
    <Pressable
      className="flex-row items-center px-4 py-3 border-b border-border active:bg-background"
      onPress={handlePress}
    >
      <View className="mr-3">
        <ContactAvatar name={contact.name} size={40} />
      </View>
      <View className="flex-1">
        <Text className="text-foreground text-sm font-medium">{contact.name}</Text>
        <Text className="text-muted-foreground text-xs mt-0.5">
          {truncateAddress(contact.address)}
        </Text>
      </View>
    </Pressable>
  );
}

export function ContactPicker({
  visible,
  onSelect,
  onClose,
}: ContactPickerProps) {
  const contacts = useContactsStore((s) => s.contacts);
  const loadContacts = useContactsStore((s) => s.loadContacts);
  const theme = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ContactRow[] | null>(null);

  const handleOpen = useCallback(() => {
    const db = getDatabase();
    if (db) {
      loadContacts(db);
    }
    setSearchQuery("");
    setSearchResults(null);
  }, [loadContacts]);

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (query.trim() === "") {
        setSearchResults(null);
        return;
      }
      const db = getDatabase();
      if (db) {
        db.searchContacts(query.trim()).then(setSearchResults);
      }
    },
    [],
  );

  const displayContacts = useMemo(
    () => searchResults ?? contacts,
    [searchResults, contacts],
  );

  const handleSelect = useCallback(
    (address: string) => {
      onSelect(address);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleClose = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
    onClose();
  }, [onClose]);

  const renderItem = useCallback(
    ({ item }: { item: ContactRow }) => (
      <ContactPickerItem contact={item} onPress={handleSelect} />
    ),
    [handleSelect],
  );

  const keyExtractor = useCallback((item: ContactRow) => item.id, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleClose}
      onShow={handleOpen}
    >
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="pt-14 pb-3 px-6 flex-row items-center justify-between bg-background border-b border-border">
          <Text className="text-foreground text-lg font-bold">
            {t("contactPicker.title")}
          </Text>
          <Pressable onPress={handleClose} className="p-2">
            <Text className="text-primary text-base font-semibold">
              {t("common.close")}
            </Text>
          </Pressable>
        </View>

        {/* Search */}
        <View className="px-4 py-3">
          <View className="bg-surface border border-border rounded-xl px-4 py-2.5">
            <TextInput
              className="text-foreground text-sm"
              placeholder={t("contactPicker.searchPlaceholder")}
              placeholderTextColor={theme.colors.textSecondary}
              value={searchQuery}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        {/* Contact list */}
        {displayContacts.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-muted-foreground text-base text-center">
              {searchQuery
                ? t("contactPicker.emptySearch")
                : t("contactPicker.empty")}
            </Text>
          </View>
        ) : (
          <FlashList
            data={displayContacts}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            className="flex-1"
            contentContainerClassName="pb-8"
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}

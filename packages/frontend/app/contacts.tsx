/**
 * Contacts / Address Book screen.
 * Full-screen modal for managing contacts with CRUD operations.
 * Google Contacts-inspired UI: rounded search pill, large avatars, full-screen edit form.
 */

import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { FlashList } from "@shopify/flash-list";
import { useContactsStore } from "../src/wallet/contacts-store";
import { getDatabase } from "../src/wallet/wallet-store";
import type { ContactRow } from "../src/storage/database";
import { ContactAvatar, EmptyState } from "../src/ui/components";
import { QRScanner } from "../src/ui/components/QRScanner";
import type { ScannedCode } from "../src/pay/scanned-code";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { t } from "../src/i18n";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTENT_MAX_WIDTH_CLASS = "w-full max-w-2xl mx-auto";

/** Module constant so the prop keeps a stable reference across renders. */
const CONTACT_SCAN_KINDS: readonly ScannedCode["kind"][] = ["address"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Form field — filled surface field (card-less, matches SendSheet)
// ---------------------------------------------------------------------------

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

interface FormFieldProps {
  label: string;
  icon: IconName;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
  multiline?: boolean;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
  trailing?: React.ReactNode;
}

function FormField({
  label,
  icon,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = "sentences",
  autoCorrect = true,
  multiline = false,
  focused,
  onFocus,
  onBlur,
  trailing,
}: FormFieldProps) {
  const theme = useTheme();
  const iconColor = focused ? theme.colors.primary : theme.colors.textSecondary;

  return (
    <View className="px-5 pt-4">
      <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-2">
        {label}
      </Text>
      <View
        className={`flex-row bg-surface rounded-2xl px-4 py-3.5 ${
          multiline ? "items-start" : "items-center"
        }`}
      >
        <View className={multiline ? "pt-0.5" : undefined}>
          <MaterialCommunityIcons name={icon} size={20} color={iconColor} />
        </View>
        <TextInput
          className="flex-1 text-foreground text-base ml-3"
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSecondary}
          value={value}
          onChangeText={onChangeText}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          multiline={multiline}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        {trailing}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Contact form modal — full-screen Google-Contacts style
// ---------------------------------------------------------------------------

interface ContactFormProps {
  visible: boolean;
  editingContact: ContactRow | null;
  onSave: (name: string, address: string, notes: string) => void;
  onClose: () => void;
}

type FocusedField = "name" | "address" | "notes" | null;

function ContactForm({
  visible,
  editingContact,
  onSave,
  onClose,
}: ContactFormProps) {
  const theme = useTheme();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const clipboardErrorControl = useDialogControl();

  const handleOpen = useCallback(() => {
    if (editingContact) {
      setName(editingContact.name);
      setAddress(editingContact.address);
      setNotes(editingContact.notes);
    } else {
      setName("");
      setAddress("");
      setNotes("");
    }
    setFocusedField(null);
  }, [editingContact]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setAddress(text.trim());
      }
    } catch {
      clipboardErrorControl.open();
    }
  }, [clipboardErrorControl]);

  // `accepts` below narrows this to the address case; an address book has
  // nothing to do with a payment request.
  const handleQRScan = useCallback((code: ScannedCode) => {
    if (code.kind !== "address") return;
    setAddress(code.address);
  }, []);

  const canSave = name.trim().length > 0 && address.trim().length >= 25;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    onSave(name.trim(), address.trim(), notes.trim());
  }, [canSave, name, address, notes, onSave]);

  const handleClose = useCallback(() => {
    setName("");
    setAddress("");
    setNotes("");
    setFocusedField(null);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
      onShow={handleOpen}
    >
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <View className={`flex-1 ${CONTENT_MAX_WIDTH_CLASS}`}>
          {/* Header row */}
          <View className="flex-row items-center px-3 py-2">
            <Pressable
              onPress={handleClose}
              className="w-11 h-11 items-center justify-center rounded-full active:bg-surface"
              accessibilityLabel={t("contacts.closeAccessibility")}
            >
              <MaterialCommunityIcons
                name="close"
                size={24}
                color={theme.colors.text}
              />
            </Pressable>
            <Text className="flex-1 text-foreground text-lg font-semibold ml-2">
              {editingContact ? t("contacts.edit") : t("contacts.newContact")}
            </Text>
            <Pressable
              onPress={handleSave}
              disabled={!canSave}
              className={`h-11 px-5 rounded-full items-center justify-center ${
                canSave ? "bg-primary active:opacity-80" : "bg-muted opacity-60"
              }`}
              accessibilityLabel={t("contacts.saveAccessibility")}
            >
              <Text
                className={`text-sm font-semibold ${
                  canSave ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {t("common.save")}
              </Text>
            </Pressable>
          </View>

          {/* Hairline divider under the header (card-less) */}
          <View className="h-px bg-border" />

          <ScrollView
            className="flex-1"
            contentContainerClassName="pb-12"
            keyboardShouldPersistTaps="handled"
          >
            {/* Large initial avatar */}
            <View className="items-center pt-8 pb-6">
              <ContactAvatar
                name={name || (editingContact?.name ?? "")}
                size={96}
              />
            </View>

            {/* Form fields */}
            <View className="mt-2">
              <FormField
                label={t("contacts.field.name")}
                icon="account-outline"
                value={name}
                onChangeText={setName}
                placeholder={t("contacts.field.namePlaceholder")}
                autoCapitalize="words"
                autoCorrect={false}
                focused={focusedField === "name"}
                onFocus={() => setFocusedField("name")}
                onBlur={() => setFocusedField(null)}
              />

              <FormField
                label={t("contacts.field.address")}
                icon="key-outline"
                value={address}
                onChangeText={setAddress}
                placeholder={t("contacts.field.addressPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                focused={focusedField === "address"}
                onFocus={() => setFocusedField("address")}
                onBlur={() => setFocusedField(null)}
                trailing={
                  <View className="flex-row items-center ml-2">
                    <Pressable
                      onPress={handlePaste}
                      className="w-10 h-10 rounded-full items-center justify-center active:bg-surface"
                      accessibilityLabel={t("contacts.pasteAccessibility")}
                    >
                      <MaterialCommunityIcons
                        name="content-paste"
                        size={20}
                        color={theme.colors.primary}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => setShowQRScanner(true)}
                      className="w-10 h-10 rounded-full items-center justify-center active:bg-surface"
                      accessibilityLabel={t("contacts.scanAccessibility")}
                    >
                      <MaterialCommunityIcons
                        name="qrcode-scan"
                        size={20}
                        color={theme.colors.primary}
                      />
                    </Pressable>
                  </View>
                }
              />

              <FormField
                label={t("contacts.field.notes")}
                icon="note-text-outline"
                value={notes}
                onChangeText={setNotes}
                placeholder={t("contacts.field.notesPlaceholder")}
                autoCapitalize="sentences"
                multiline
                focused={focusedField === "notes"}
                onFocus={() => setFocusedField("notes")}
                onBlur={() => setFocusedField(null)}
              />
            </View>
          </ScrollView>
        </View>
      </SafeAreaView>

      <QRScanner
        visible={showQRScanner}
        accepts={CONTACT_SCAN_KINDS}
        onScan={handleQRScan}
        onClose={() => setShowQRScanner(false)}
      />

      <Dialog
        control={clipboardErrorControl}
        placement="bottom"
        title={t("contacts.clipboardError.title")}
        description={t("contacts.clipboardError.description")}
        actions={[{ label: t("common.ok") }]}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Contact list row — Google Contacts style
// ---------------------------------------------------------------------------

interface ContactRowItemProps {
  contact: ContactRow;
  onPress: () => void;
  onLongPress: () => void;
}

function ContactRowItem({ contact, onPress, onLongPress }: ContactRowItemProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className="flex-row items-center px-5 py-3 active:bg-surface"
    >
      <View className="mr-4">
        <ContactAvatar name={contact.name} size={48} />
      </View>
      <View className="flex-1">
        <Text
          className="text-foreground text-base font-medium"
          numberOfLines={1}
        >
          {contact.name}
        </Text>
        <Text
          className="text-muted-foreground text-[13px] mt-0.5"
          numberOfLines={1}
        >
          {truncateAddress(contact.address)}
        </Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Main contacts screen
// ---------------------------------------------------------------------------

export default function ContactsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const isPickMode = params.mode === "pick";
  const theme = useTheme();

  const contacts = useContactsStore((s) => s.contacts);
  const loadContacts = useContactsStore((s) => s.loadContacts);
  const addContact = useContactsStore((s) => s.addContact);
  const updateContact = useContactsStore((s) => s.updateContact);
  const deleteContact = useContactsStore((s) => s.deleteContact);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ContactRow[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [pendingDeleteContact, setPendingDeleteContact] =
    useState<ContactRow | null>(null);
  const [longPressContact, setLongPressContact] =
    useState<ContactRow | null>(null);
  const deleteContactControl = useDialogControl();
  const longPressMenuControl = useDialogControl();

  const handleLayout = useCallback(() => {
    const db = getDatabase();
    if (db) {
      loadContacts(db);
    }
  }, [loadContacts]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (query.trim() === "") {
      setSearchResults(null);
      return;
    }
    const db = getDatabase();
    if (db) {
      db.searchContacts(query.trim()).then(setSearchResults);
    }
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
  }, []);

  const displayContacts = useMemo(
    () => searchResults ?? contacts,
    [searchResults, contacts],
  );

  const handleAddPress = useCallback(() => {
    setEditingContact(null);
    setShowForm(true);
  }, []);

  const handleContactPress = useCallback(
    (contact: ContactRow) => {
      if (isPickMode) {
        router.back();
        return;
      }
      setEditingContact(contact);
      setShowForm(true);
    },
    [isPickMode, router],
  );

  const handleContactLongPress = useCallback(
    (contact: ContactRow) => {
      setLongPressContact(contact);
      longPressMenuControl.open();
    },
    [longPressMenuControl],
  );

  const handleLongPressEdit = useCallback(() => {
    if (!longPressContact) return;
    setEditingContact(longPressContact);
    setShowForm(true);
    setLongPressContact(null);
  }, [longPressContact]);

  const handleLongPressCopy = useCallback(() => {
    if (!longPressContact) return;
    Clipboard.setStringAsync(longPressContact.address);
    setLongPressContact(null);
  }, [longPressContact]);

  const handleLongPressDelete = useCallback(() => {
    if (!longPressContact) return;
    setPendingDeleteContact(longPressContact);
    setLongPressContact(null);
    deleteContactControl.open();
  }, [longPressContact, deleteContactControl]);

  const handleFormSave = useCallback(
    (name: string, address: string, notes: string) => {
      const db = getDatabase();
      if (!db) return;

      if (editingContact) {
        updateContact(db, editingContact.id, name, address, notes);
      } else {
        addContact(db, name, address, notes);
      }

      setShowForm(false);
      setEditingContact(null);
    },
    [editingContact, addContact, updateContact],
  );

  const handleFormClose = useCallback(() => {
    setShowForm(false);
    setEditingContact(null);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ContactRow }) => (
      <ContactRowItem
        contact={item}
        onPress={() => handleContactPress(item)}
        onLongPress={() => handleContactLongPress(item)}
      />
    ),
    [handleContactPress, handleContactLongPress],
  );

  const keyExtractor = useCallback((item: ContactRow) => item.id, []);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
      onLayout={handleLayout}
    >
      <View className={`flex-1 ${CONTENT_MAX_WIDTH_CLASS}`}>
        {/* Header */}
        <View className="flex-row items-center px-3 py-2">
          <Pressable
            onPress={() => router.back()}
            className="w-11 h-11 items-center justify-center rounded-full active:bg-surface"
            accessibilityLabel={t("contacts.backAccessibility")}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={24}
              color={theme.colors.text}
            />
          </Pressable>
          <Text className="flex-1 text-foreground text-lg font-semibold ml-2">
            {t("contacts.title")}
          </Text>
          <Pressable
            onPress={handleAddPress}
            className="w-11 h-11 items-center justify-center rounded-full active:bg-surface"
            accessibilityLabel={t("contacts.addAccessibility")}
          >
            <MaterialCommunityIcons
              name="plus"
              size={26}
              color={theme.colors.primary}
            />
          </Pressable>
        </View>

        {/* Search field — card-less filled surface */}
        <View className="px-4 pt-1 pb-3">
          <View className="flex-row items-center bg-surface rounded-2xl px-4 py-3.5">
            <MaterialCommunityIcons
              name="magnify"
              size={22}
              color={theme.colors.textSecondary}
            />
            <TextInput
              className="flex-1 text-foreground text-base ml-3"
              placeholder={t("contacts.searchPill")}
              placeholderTextColor={theme.colors.textSecondary}
              value={searchQuery}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {searchQuery.length > 0 ? (
              <Pressable
                onPress={handleClearSearch}
                className="w-8 h-8 items-center justify-center rounded-full active:bg-background"
                accessibilityLabel={t("contacts.clearSearchAccessibility")}
              >
                <MaterialCommunityIcons
                  name="close-circle"
                  size={18}
                  color={theme.colors.textSecondary}
                />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Contact list */}
        {displayContacts.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <EmptyState
              icon="book-open-variant"
              title={
                searchQuery
                  ? t("contacts.emptySearch")
                  : t("contacts.empty")
              }
              subtitle={searchQuery ? undefined : t("contacts.emptyAddOne")}
            />
          </View>
        ) : (
          <FlashList
            data={displayContacts}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            className="flex-1"
            contentContainerClassName="pb-24"
          />
        )}
      </View>

      {/* Contact form modal */}
      <ContactForm
        visible={showForm}
        editingContact={editingContact}
        onSave={handleFormSave}
        onClose={handleFormClose}
      />

      {/* Long-press action menu prompt */}
      <Dialog
        control={longPressMenuControl}
        onClose={() => setLongPressContact(null)}
        placement="bottom"
        title={longPressContact?.name ?? ""}
        description={
          longPressContact ? truncateAddress(longPressContact.address) : ""
        }
        actions={[
          { label: t("common.edit"), onPress: handleLongPressEdit },
          { label: t("contacts.copyAddress"), onPress: handleLongPressCopy },
          {
            label: t("common.delete"),
            onPress: handleLongPressDelete,
            color: "destructive",
          },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />

      {/* Delete contact confirmation prompt */}
      <Dialog
        control={deleteContactControl}
        placement="bottom"
        title={t("contacts.delete.title")}
        description={
          pendingDeleteContact
            ? t("contacts.delete.description", {
                name: pendingDeleteContact.name,
              })
            : ""
        }
        actions={[
          {
            label: t("common.delete"),
            color: "destructive",
            onPress: () => {
              if (pendingDeleteContact) {
                const db = getDatabase();
                if (db) {
                  deleteContact(db, pendingDeleteContact.id);
                }
                setPendingDeleteContact(null);
              }
            },
          },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />
    </SafeAreaView>
  );
}

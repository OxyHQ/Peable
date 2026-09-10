/**
 * Language picker screen.
 *
 * Revolut-inspired flow: searchable list of all supported languages with the
 * current selection marked by a check icon. Presented as a modal from both
 * the welcome screen and the settings screen.
 */

import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useTheme } from "@oxy.so/bloom/theme";
import { EmptyState, ScreenHeader } from "../src/ui/components";
import { SUPPORTED_LANGUAGES, t, type LanguageOption } from "../src/i18n";
import { useLanguageStore } from "../src/i18n/store";

const CONTENT_MAX_WIDTH_CLASS = "w-full max-w-[600px] mx-auto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesQuery(option: LanguageOption, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    option.nativeName.toLowerCase().includes(needle) ||
    option.englishName.toLowerCase().includes(needle) ||
    option.code.toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface LanguageRowProps {
  option: LanguageOption;
  selected: boolean;
  isLast: boolean;
  onPress: (code: string) => void;
}

function LanguageRow({ option, selected, isLast, onPress }: LanguageRowProps) {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onPress(option.code);
  }, [onPress, option.code]);

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center px-4 py-3 min-h-[60px] active:bg-background"
      style={
        isLast
          ? undefined
          : {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            }
      }
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={t("language.selectAccessibility", {
        name: option.englishName,
      })}
    >
      <View
        className={`w-9 h-9 rounded-full items-center justify-center ${
          selected ? "bg-primary/10" : "bg-background"
        }`}
      >
        <Text className="text-lg" accessibilityElementsHidden>
          {option.flag}
        </Text>
      </View>
      <View className="flex-1 ml-3">
        <Text
          className={`text-base font-medium ${
            selected ? "text-primary" : "text-foreground"
          }`}
          numberOfLines={1}
        >
          {option.nativeName}
        </Text>
        <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
          {option.englishName}
        </Text>
      </View>
      {selected ? (
        <MaterialCommunityIcons
          name="check"
          size={20}
          color={theme.colors.primary}
        />
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LanguageScreen() {
  const router = useRouter();
  const theme = useTheme();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () =>
      SUPPORTED_LANGUAGES.filter((option) => matchesQuery(option, query)),
    [query],
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleSelect = useCallback(
    async (code: string) => {
      if (code !== language) {
        await setLanguage(code);
      }
      router.back();
    },
    [language, setLanguage, router],
  );

  const handleClearQuery = useCallback(() => {
    setQuery("");
  }, []);

  const renderItem = useCallback<ListRenderItem<LanguageOption>>(
    ({ item, index }) => (
      <LanguageRow
        option={item}
        selected={item.code === language}
        isLast={index === filtered.length - 1}
        onPress={handleSelect}
      />
    ),
    [language, filtered.length, handleSelect],
  );

  const keyExtractor = useCallback(
    (item: LanguageOption) => item.code,
    [],
  );

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <View className={`flex-1 ${CONTENT_MAX_WIDTH_CLASS}`}>
        <ScreenHeader title={t("language.title")} onBack={handleBack} />

        {/* Search pill */}
        <View className="px-4 pt-1 pb-3">
          <View className="flex-row items-center bg-surface px-4 rounded-full min-h-[48px]">
            <MaterialCommunityIcons
              name="magnify"
              size={22}
              color={theme.colors.textSecondary}
            />
            <TextInput
              className="flex-1 text-foreground text-base ml-3 py-2"
              placeholder={t("language.searchPlaceholder")}
              placeholderTextColor={theme.colors.textSecondary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 ? (
              <Pressable
                onPress={handleClearQuery}
                className="w-8 h-8 items-center justify-center rounded-full active:bg-background"
                accessibilityLabel={t("language.clearSearchAccessibility")}
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

        {filtered.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <EmptyState icon="magnify" title={t("language.noResults")} />
          </View>
        ) : (
          <View className="flex-1 mb-4">
            {/* Full-bleed rows: each LanguageRow carries px-4 so its content
                aligns while its hairline divider runs edge-to-edge. */}
            <FlashList
              data={filtered}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              className="flex-1"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

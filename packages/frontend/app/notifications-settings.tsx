/**
 * Payment-notification settings ("Notificaciones de pago").
 *
 * Exposes the privacy dial and per-event controls for background notifications
 * (design §4.4/§4.5): a master toggle, the notification-server URL (official
 * Explorer by default, editable so a user can point at their own node), the
 * confirmation depth, and per-event switches. All changes persist through the
 * observable prefs store, which the registration lifecycle subscribes to and
 * re-registers on.
 *
 * Card-less design matching the main Settings screen: uppercase section labels
 * above flat groups of rows that sit directly on the background, separated by
 * the shared `ListItem`'s own edge-to-edge hairline dividers, plus filled
 * inputs — no surface boxes, no borders around row groups.
 */

import { useCallback, useState } from "react";
import { View, Text, TextInput, ScrollView } from "react-native";
import { Switch } from "@oxyhq/bloom/switch";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useRouter, useFocusEffect } from "expo-router";
import { useTheme } from "@oxyhq/bloom/theme";
import { ListItem, ScreenHeader } from "../src/ui/components";
import { t } from "../src/i18n";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  DEFAULT_NOTIFICATION_SERVER_URL,
  type NotificationEvent,
  type NotificationPrefs,
} from "../src/services/notification-settings";
import { initNotifications } from "../src/services/notifications";

const CONTENT_MAX_WIDTH_CLASS = "w-full max-w-[600px] mx-auto";

/** Selectable confirmation depths, cycled on tap (BIP44 default 1). */
const CONFIRMATION_OPTIONS = [1, 2, 3, 6];

/** Uppercase section header — matches the main Settings screen's section labels. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

interface EventRow {
  event: NotificationEvent;
  labelKey: string;
  icon: IconName;
}

const EVENT_ROWS: EventRow[] = [
  {
    event: "incoming_pending",
    labelKey: "notificationsSettings.events.incomingPending",
    icon: "arrow-down-circle-outline",
  },
  {
    event: "incoming_confirmed",
    labelKey: "notificationsSettings.events.incomingConfirmed",
    icon: "arrow-down-circle",
  },
  {
    event: "outgoing_confirmed",
    labelKey: "notificationsSettings.events.outgoingConfirmed",
    icon: "arrow-up-circle",
  },
];

// ---------------------------------------------------------------------------
// Settings section — an uppercase label above a flat, card-less group of rows
// that sit directly on the background, separated by the ListItem's own hairline
// dividers (matches the main Settings screen's `SettingsSection`). The label and
// footer carry px-4 so they align with the row content, which Bloom's Item pads
// 16px internally. An optional footer renders muted helper text below the group.
// ---------------------------------------------------------------------------

function SettingsSection({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="mb-6">
      <Text className={`${SECTION_LABEL} mb-1 px-4`}>{title}</Text>
      <View>
        {children}
      </View>
      {footer ? (
        <Text className="text-muted-foreground text-xs mt-2 px-4">{footer}</Text>
      ) : null}
    </View>
  );
}

export default function NotificationsSettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const colors = theme.colors;

  const [enabled, setEnabled] = useState(false);
  const [serverUrlDraft, setServerUrlDraft] = useState(
    DEFAULT_NOTIFICATION_SERVER_URL,
  );
  const [confirmations, setConfirmations] = useState(1);
  const [events, setEvents] = useState<NotificationEvent[]>([]);

  const applyLoaded = useCallback((prefs: NotificationPrefs) => {
    setEnabled(prefs.enabled);
    setServerUrlDraft(prefs.serverUrl);
    setConfirmations(prefs.confirmations);
    setEvents(prefs.events);
  }, []);

  // Load persisted prefs when the screen gains focus.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getNotificationPrefs()
        .then((prefs) => {
          if (!cancelled) applyLoaded(prefs);
        })
        .catch(() => {
          // Defaults from useState initializers stand if the load fails.
        });
      return () => {
        cancelled = true;
      };
    }, [applyLoaded]),
  );

  const persist = useCallback(
    async (patch: Partial<NotificationPrefs>) => {
      const next = await setNotificationPrefs(patch);
      applyLoaded(next);
    },
    [applyLoaded],
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleToggleEnabled = useCallback(
    (value: boolean) => {
      if (value) {
        // Prompt for OS notification permission the first time it's enabled so
        // the device push token can be acquired for registration.
        void initNotifications();
      }
      void persist({ enabled: value });
    },
    [persist],
  );

  const handleServerUrlBlur = useCallback(() => {
    const trimmed = serverUrlDraft.trim();
    void persist({ serverUrl: trimmed.length > 0 ? trimmed : DEFAULT_NOTIFICATION_SERVER_URL });
  }, [serverUrlDraft, persist]);

  const handleResetServerUrl = useCallback(() => {
    setServerUrlDraft(DEFAULT_NOTIFICATION_SERVER_URL);
    void persist({ serverUrl: DEFAULT_NOTIFICATION_SERVER_URL });
  }, [persist]);

  const handleCycleConfirmations = useCallback(() => {
    const idx = CONFIRMATION_OPTIONS.indexOf(confirmations);
    const next = CONFIRMATION_OPTIONS[(idx + 1) % CONFIRMATION_OPTIONS.length];
    void persist({ confirmations: next });
  }, [confirmations, persist]);

  const handleToggleEvent = useCallback(
    (event: NotificationEvent, on: boolean) => {
      const set = new Set(events);
      if (on) set.add(event);
      else set.delete(event);
      const ordered = EVENT_ROWS.map((row) => row.event).filter((e) =>
        set.has(e),
      );
      void persist({ events: ordered });
    },
    [events, persist],
  );

  const isDefaultServer =
    serverUrlDraft.trim().replace(/\/+$/, "") ===
    DEFAULT_NOTIFICATION_SERVER_URL;

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <View className={`flex-1 ${CONTENT_MAX_WIDTH_CLASS}`}>
        <ScreenHeader
          title={t("notificationsSettings.title")}
          onBack={handleBack}
        />

        <ScrollView
          className="flex-1"
          contentContainerClassName="pt-3 pb-10"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Master toggle — a label-less bordered surface, mirroring the
              Settings screen's identity hero row. */}
          <View className="mb-6">
            <ListItem
              title={t("notificationsSettings.enable.title")}
              subtitle={t("notificationsSettings.enable.description")}
              icon="bell-ring"
              iconColor={colors.primary}
              iconBg="bg-primary/10"
              showChevron={false}
              trailing={
                <Switch
                  value={enabled}
                  onValueChange={handleToggleEnabled}
                />
              }
              isLast
            />
          </View>

          {enabled ? (
            <>
              {/* Notification server (privacy dial) */}
              <SettingsSection
                title={t("notificationsSettings.server.group")}
                footer={t("notificationsSettings.server.hint")}
              >
                <View
                  className={`px-4 py-3.5 ${isDefaultServer ? "" : "border-b border-border"}`}
                >
                  <Text className="text-muted-foreground text-xs mb-2">
                    {t("notificationsSettings.server.label")}
                  </Text>
                  <TextInput
                    className="bg-background text-foreground text-base rounded-2xl px-4 py-3.5"
                    value={serverUrlDraft}
                    onChangeText={setServerUrlDraft}
                    onBlur={handleServerUrlBlur}
                    onEndEditing={handleServerUrlBlur}
                    placeholder={DEFAULT_NOTIFICATION_SERVER_URL}
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                  />
                </View>
                {isDefaultServer ? null : (
                  <ListItem
                    title={t("notificationsSettings.server.reset")}
                    icon="backup-restore"
                    iconColor={colors.primary}
                    iconBg="bg-primary/10"
                    onPress={handleResetServerUrl}
                    isLast
                  />
                )}
              </SettingsSection>

              {/* Confirmation depth */}
              <SettingsSection
                title={t("notificationsSettings.confirmations.group")}
              >
                <ListItem
                  title={t("notificationsSettings.confirmations.title")}
                  subtitle={t("notificationsSettings.confirmations.description")}
                  value={t("notificationsSettings.confirmations.value", {
                    count: confirmations,
                  })}
                  icon="layers-triple"
                  iconColor={colors.primary}
                  iconBg="bg-primary/10"
                  onPress={handleCycleConfirmations}
                  isLast
                />
              </SettingsSection>

              {/* Per-event switches */}
              <SettingsSection
                title={t("notificationsSettings.events.group")}
              >
                {EVENT_ROWS.map((row, idx) => (
                  <ListItem
                    key={row.event}
                    title={t(row.labelKey)}
                    icon={row.icon}
                    iconColor={colors.primary}
                    iconBg="bg-primary/10"
                    showChevron={false}
                    trailing={
                      <Switch
                        value={events.includes(row.event)}
                        onValueChange={(on) => handleToggleEvent(row.event, on)}
                      />
                    }
                    isLast={idx === EVENT_ROWS.length - 1}
                  />
                ))}
              </SettingsSection>
            </>
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

/**
 * Pocket create/edit sheet content: a tappable circular image avatar, name,
 * color swatches, and an optional FAIR goal. Content-only body for a Bloom
 * `<Dialog placement="bottom">`, mirroring `MovePocketSheet`'s conventions.
 *
 * One component serves both flows: `target === null` creates a new Pocket,
 * `target` set edits an existing one (prefilled, and renames it if the name
 * changed). Callers should remount this with `key={target?.account ?? "create"}`
 * when switching targets — its state is seeded from `target` once, not kept in
 * sync via an effect.
 *
 * A picked image is copied out of the picker's temporary location into the
 * app's document directory, because the Pocket registry persists only the URI
 * and the picker's cache copy is not guaranteed to survive.
 */

import type React from "react";
import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, Platform } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { useWalletStore } from "../../wallet/wallet-store";
import { POCKET_COLORS, type PocketInfo } from "../../wallet/pockets";
import { AmountInput, Button, PocketAvatar } from "../components";
import { t } from "../../i18n";

const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

/** Diameter of the form's hero avatar. */
const AVATAR_SIZE = 88;

/** Subdirectory of the document directory holding persisted Pocket images. */
const IMAGE_DIRECTORY = "pockets";

/** Options shared by both pickers — a square crop, since the avatar is circular. */
const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.8,
};

/**
 * Copy a picked image into the document directory and return its stable URI.
 * The filename is unique per pick so replacing a Pocket's image never collides
 * with (or has to invalidate a cache of) the previous one.
 *
 * Native only: on web `expo-file-system` is a no-op stub and the picker already
 * returns a browser-owned object URL, so that URL is used as-is (and, like any
 * object URL, only lives for the session).
 */
async function persistPickedImage(
  uri: string,
  account: number | undefined,
): Promise<string> {
  if (Platform.OS === "web") return uri;
  const directory = new Directory(Paths.document, IMAGE_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(
    directory,
    `${account ?? "new"}-${Date.now()}.jpg`,
  );
  await new File(uri).copy(destination);
  return destination.uri;
}

/**
 * Delete an image this app had stored for a Pocket, once the registry no longer
 * references it. Called only AFTER a successful save, so a failure here can
 * never cost the user their edit — it just leaves a stale file behind, which is
 * worth a warning rather than an error the user has to act on. Scoped to
 * {@link IMAGE_DIRECTORY} so a URI from anywhere else is never touched.
 */
function discardStoredImage(uri: string): void {
  if (Platform.OS === "web" || !uri.includes(`/${IMAGE_DIRECTORY}/`)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (err: unknown) {
    console.warn("[pockets] could not delete the replaced Pocket image", err);
  }
}

export function PocketFormSheet({
  target,
  onDone,
}: {
  target: PocketInfo | null;
  onDone: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const createPocket = useWalletStore((s) => s.createPocket);
  const renamePocket = useWalletStore((s) => s.renamePocket);
  const updatePocketMeta = useWalletStore((s) => s.updatePocketMeta);

  const [name, setName] = useState(target?.name ?? "");
  const [image, setImage] = useState<string | undefined>(target?.image);
  const [color, setColor] = useState(target?.color ?? POCKET_COLORS[0]);
  const [goal, setGoal] = useState(
    target?.goal !== undefined ? String(target.goal) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imageSourceControl = useDialogControl();

  const handlePick = useCallback(
    async (source: "gallery" | "camera") => {
      setError(null);
      try {
        const permission =
          source === "gallery"
            ? await ImagePicker.requestMediaLibraryPermissionsAsync()
            : await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError(t("pockets.create.permissionDenied"));
          return;
        }
        const result =
          source === "gallery"
            ? await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS)
            : await ImagePicker.launchCameraAsync(PICKER_OPTIONS);
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;
        setImage(await persistPickedImage(asset.uri, target?.account));
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : t("pockets.create.error.failed"),
        );
      }
    },
    [target],
  );

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("pockets.create.error.nameRequired"));
      return;
    }
    const trimmedGoal = goal.trim();
    let goalValue: number | undefined;
    if (trimmedGoal) {
      const parsed = Number.parseFloat(trimmedGoal);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError(t("pockets.create.error.invalidGoal"));
        return;
      }
      goalValue = parsed;
    }

    setBusy(true);
    setError(null);
    try {
      if (target) {
        await updatePocketMeta(target.account, {
          // `null` clears the image the user removed; a string sets a new one.
          image: image ?? null,
          color,
          goal: goalValue ?? null,
        });
        if (trimmedName !== target.name) {
          await renamePocket(target.account, trimmedName);
        }
        if (target.image && target.image !== image) {
          discardStoredImage(target.image);
        }
      } else {
        await createPocket(trimmedName, image, color, goalValue);
      }
      onDone();
    } catch {
      setError(t(target ? "pockets.edit.error.failed" : "pockets.create.error.failed"));
    } finally {
      setBusy(false);
    }
  }, [name, goal, image, color, target, createPocket, renamePocket, updatePocketMeta, onDone]);

  return (
    <View className="w-full self-center gap-5" style={{ maxWidth: 500 }}>
      {!target ? (
        <Text className="text-muted-foreground text-[13.5px] leading-5 -mt-1">
          {t("pockets.create.lead")}
        </Text>
      ) : null}

      {/* Image avatar — the Pocket's identity, tapped to pick a photo. The
          previewed Pocket is assembled from the live form state so the crop,
          color, and name-initial fallback all update as they are edited. The
          camera badge is the affordance; the label it would duplicate is on
          the Pressable for screen readers. */}
      <View>
        <Text className={SECTION_LABEL}>{t("pockets.create.imageLabel")}</Text>
        <Pressable
          onPress={() => imageSourceControl.open()}
          accessibilityRole="button"
          accessibilityLabel={t(
            image ? "pockets.create.changeImage" : "pockets.create.addImage",
          )}
          className="self-center mt-2 active:opacity-80"
        >
          <PocketAvatar
            pocket={{
              account: target?.account ?? -1,
              name,
              createdAt: target?.createdAt ?? 0,
              color,
              image,
            }}
            size={AVATAR_SIZE}
          />
          <View
            className="absolute bottom-0 right-0 w-7 h-7 rounded-full items-center justify-center border-2 border-surface"
            style={{ backgroundColor: color }}
          >
            <MaterialCommunityIcons name="camera" size={14} color="#fff" />
          </View>
        </Pressable>
      </View>

      <View>
        <Text className={SECTION_LABEL}>{t("pockets.create.nameLabel")}</Text>
        <TextInput
          className="bg-surface rounded-2xl px-4 py-3.5 text-foreground text-base mt-2"
          placeholder={t("pockets.create.namePlaceholder")}
          placeholderTextColor={theme.colors.textSecondary}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoCorrect={false}
        />
      </View>

      <View>
        <Text className={SECTION_LABEL}>{t("pockets.create.colorLabel")}</Text>
        <View className="flex-row flex-wrap gap-3 mt-2">
          {POCKET_COLORS.map((option) => {
            const selected = option === color;
            return (
              <Pressable
                key={option}
                onPress={() => setColor(option)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                className="w-9 h-9 rounded-full items-center justify-center"
                style={{
                  backgroundColor: option,
                  borderWidth: selected ? 2 : 0,
                  borderColor: theme.colors.text,
                }}
              >
                {selected ? (
                  <MaterialCommunityIcons name="check" size={15} color="#fff" />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>

      <View>
        <Text className={SECTION_LABEL}>{t("pockets.create.goalLabel")}</Text>
        <AmountInput
          className="bg-surface rounded-2xl px-4 py-3.5 text-foreground text-base mt-2"
          placeholder={t("pockets.create.goalPlaceholder")}
          placeholderTextColor={theme.colors.textSecondary}
          value={goal}
          onValueChange={setGoal}
        />
      </View>

      {error ? (
        <View className="bg-destructive/10 rounded-2xl p-3">
          <Text className="text-destructive text-sm text-center">{error}</Text>
        </View>
      ) : null}

      <Button
        title={target ? t("pockets.edit.cta") : t("pockets.create.cta")}
        onPress={handleSubmit}
        variant="primary"
        disabled={busy}
        loading={busy}
      />

      {/* Image source chooser — the picker launches after this closes
          (`shouldCloseOnPress` defaults to true), so the system UI never has to
          compete with the sheet for the foreground. */}
      <Dialog
        control={imageSourceControl}
        placement="bottom"
        title={t("pockets.create.imageSourceTitle")}
        actions={[
          {
            label: t("pockets.create.gallery"),
            onPress: () => handlePick("gallery"),
          },
          {
            label: t("pockets.create.camera"),
            onPress: () => handlePick("camera"),
          },
          ...(image
            ? [
                {
                  label: t("pockets.create.removeImage"),
                  color: "destructive" as const,
                  onPress: () => setImage(undefined),
                },
              ]
            : []),
          { label: t("common.cancel"), color: "cancel" as const },
        ]}
      />
    </View>
  );
}

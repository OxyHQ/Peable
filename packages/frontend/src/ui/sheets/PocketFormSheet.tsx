/**
 * Pocket create/edit sheet content: name, emoji picker, color swatches, and
 * an optional FAIR goal. Content-only body for a Bloom `<Dialog placement="bottom">`,
 * mirroring `MovePocketSheet`'s conventions.
 *
 * One component serves both flows: `target === null` creates a new Pocket,
 * `target` set edits an existing one (prefilled, and renames it if the name
 * changed). Callers should remount this with `key={target?.account ?? "create"}`
 * when switching targets — its state is seeded from `target` once, not kept in
 * sync via an effect.
 */

import type React from "react";
import { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { useWalletStore } from "../../wallet/wallet-store";
import { POCKET_COLORS, POCKET_EMOJIS, type PocketInfo } from "../../wallet/pockets";
import { AmountInput, Button } from "../components";
import { t } from "../../i18n";

const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

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
  const [emoji, setEmoji] = useState(target?.emoji ?? POCKET_EMOJIS[0]);
  const [color, setColor] = useState(target?.color ?? POCKET_COLORS[0]);
  const [goal, setGoal] = useState(
    target?.goal !== undefined ? String(target.goal) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          emoji,
          color,
          goal: goalValue ?? null,
        });
        if (trimmedName !== target.name) {
          await renamePocket(target.account, trimmedName);
        }
      } else {
        await createPocket(trimmedName, emoji, color, goalValue);
      }
      onDone();
    } catch {
      setError(t(target ? "pockets.edit.error.failed" : "pockets.create.error.failed"));
    } finally {
      setBusy(false);
    }
  }, [name, goal, emoji, color, target, createPocket, renamePocket, updatePocketMeta, onDone]);

  return (
    <View className="w-full self-center gap-5" style={{ maxWidth: 500 }}>
      {!target ? (
        <Text className="text-muted-foreground text-[13.5px] leading-5 -mt-1">
          {t("pockets.create.lead")}
        </Text>
      ) : null}

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
        <Text className={SECTION_LABEL}>{t("pockets.create.emojiLabel")}</Text>
        <View className="flex-row flex-wrap gap-2.5 mt-2">
          {POCKET_EMOJIS.map((option) => {
            const selected = option === emoji;
            return (
              <Pressable
                key={option}
                onPress={() => setEmoji(option)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                className={`w-11 h-11 rounded-2xl items-center justify-center border ${
                  selected ? "border-primary bg-primary/10" : "border-border bg-surface"
                }`}
              >
                <Text style={{ fontSize: 21 }}>{option}</Text>
              </Pressable>
            );
          })}
        </View>
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
    </View>
  );
}

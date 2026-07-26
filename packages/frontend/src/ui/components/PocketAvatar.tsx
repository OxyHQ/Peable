/**
 * PocketAvatar — the circular avatar that identifies a Pocket everywhere it is
 * shown (home card, switcher, detail hero, move legs, and the create/edit form).
 *
 * Renders the Pocket's own image when it has one; otherwise a tinted circle in
 * the Pocket's accent color carrying the first letter of its name. Purely
 * presentational: it draws the circle itself, so callers must NOT wrap it in
 * another colored circle.
 */

import { View, Text } from "react-native";
import { Image } from "expo-image";
import type { PocketInfo } from "../../wallet/pockets";

/** ~16% alpha, matching the Pockets design's `color-mix(... 16%, var(--card))` chip tint. */
const CHIP_TINT_ALPHA = "29";

/** Shown when a Pocket has neither an image nor a usable name to initial. */
const INITIAL_FALLBACK = "•";

interface PocketAvatarProps {
  pocket: PocketInfo;
  size: number;
}

export function PocketAvatar({ pocket, size }: PocketAvatarProps) {
  const radius = size / 2;

  if (pocket.image) {
    return (
      <Image
        source={{ uri: pocket.image }}
        style={{ width: size, height: size, borderRadius: radius }}
        contentFit="cover"
      />
    );
  }

  // Code-point split rather than `charAt` so a name starting with an
  // astral character (emoji, some scripts) isn't cut mid-surrogate-pair.
  const initial =
    Array.from(pocket.name.trim())[0]?.toUpperCase() ?? INITIAL_FALLBACK;

  return (
    <View
      className="items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: `${pocket.color}${CHIP_TINT_ALPHA}`,
      }}
    >
      <Text
        style={{
          color: pocket.color,
          fontWeight: "600",
          fontSize: Math.round(size * 0.44),
        }}
      >
        {initial}
      </Text>
    </View>
  );
}

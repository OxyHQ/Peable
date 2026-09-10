/**
 * Bloom Avatar wrapper for an Oxy identity — the canonical media chokepoint (a
 * bare file id resolved through the app-root `ImageResolverProvider`, Task
 * 17) plus the sanctioned `displayName ?? handle` fallback for the
 * placeholder initial. `username` is optional so this also covers identities
 * with no handle (e.g. a merchant) — the placeholder then falls back to
 * `displayName` alone, or renders Bloom's default avatar when both are
 * absent. Used everywhere an identity's avatar renders in Peable: the
 * recipient picker, the receive screen, and the transaction history.
 */
import type React from "react";
import { Avatar } from "@oxy.so/bloom/avatar";

export function UserAvatar({
  avatarFileId,
  displayName,
  username,
  size = 40,
}: {
  avatarFileId?: string;
  displayName?: string;
  username?: string;
  size?: number;
}): React.JSX.Element {
  return (
    <Avatar source={avatarFileId} variant="thumb" size={size} name={displayName ?? username} />
  );
}

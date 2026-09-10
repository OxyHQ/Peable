/**
 * ContactAvatar — thin wrapper over Bloom's Avatar using the `name` prop
 * to render a deterministic colored circle with the contact's initial.
 * Shared across the contacts screen, contact picker, transaction list, and send screen.
 */

import { Avatar } from "@oxy.so/bloom/avatar";

interface ContactAvatarProps {
  name: string;
  size: number;
}

export function ContactAvatar({ name, size }: ContactAvatarProps) {
  return <Avatar name={name} size={size} />;
}

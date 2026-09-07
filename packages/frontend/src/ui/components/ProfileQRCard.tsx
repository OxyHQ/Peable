/**
 * The code someone scans to pay you, plus the same link in plain text.
 *
 * Shared by the `/@username` profile's `self` branch and by the read-only web
 * surface, which are the same offer made in two places: this is the half of a
 * wallet that needs no private key, so it is the half a browser can show.
 */

import { View, Text } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { buildProfileUrl } from "../../pay/profile-route";

const PROFILE_QR_SIZE = 220;
const HTTPS_PREFIX = /^https:\/\//;

export function ProfileQRCard({ username }: { username: string }) {
  const profileUrl = buildProfileUrl(username);
  return (
    <View className="items-center">
      {/* True white behind the code, not the surface token: `bg-surface` is
          near-black in the dark theme this app defaults to, and a QR needs a
          light quiet zone to stay scannable. Same panel ReceiveSheet wraps the
          address QR in. */}
      <View className="bg-white rounded-3xl p-5 items-center justify-center">
        <QRCode
          value={profileUrl}
          size={PROFILE_QR_SIZE}
          color="#1b1e09"
          backgroundColor="transparent"
        />
      </View>
      {/* The link in plain text under it: a QR is useless to someone reading
          this over a call, or copying it into a message. */}
      <Text className="text-muted-foreground text-sm mt-4" selectable>
        {profileUrl.replace(HTTPS_PREFIX, "")}
      </Text>
    </View>
  );
}

/**
 * QR code scanner component using expo-camera.
 * Scans QR codes and extracts FairCoin addresses from:
 * - faircoin:<address> URIs
 * - Plain addresses (starting with F or T)
 *
 * UI styled after Revolut's QR scanner: full-bleed camera with a
 * centered square reticle, L-shaped corner indicators, an animated
 * scan line, a circular close button and a torch toggle.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  useWindowDimensions,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from "react-native-reanimated";
import { useTheme } from "@oxyhq/bloom/theme";
import { Button } from "./Button";
import { t } from "../../i18n";
import { parseScannedData } from "../../pay/scanned-code";
import type { ScannedCode } from "../../pay/scanned-code";

interface QRScannerProps {
  visible: boolean;
  onScan: (code: ScannedCode) => void;
  onClose: () => void;
  /**
   * Kinds this caller can act on; anything else is ignored and scanning
   * continues. Defaults to both. A screen that can only fill an address field
   * passes `["address"]` so a payment request does not close the scanner and
   * then silently do nothing.
   */
  accepts?: readonly ScannedCode["kind"][];
}

/** Default for `QRScannerProps.accepts` — a module constant so the default is a
 * stable reference and cannot re-run the scan callback every render. */
const ALL_SCANNED_KINDS: readonly ScannedCode["kind"][] = ["address", "payment-request"];

const FRAME_SIZE = 260;
const CORNER_LENGTH = 32;
const CORNER_THICKNESS = 4;
const CORNER_RADIUS = 20;
const SCAN_LINE_HEIGHT = 2;
const SCAN_LINE_INSET = 16;
const SCAN_LINE_DURATION_MS = 1800;

interface CornerIndicatorProps {
  position: "tl" | "tr" | "bl" | "br";
}

function CornerIndicator({ position }: CornerIndicatorProps) {
  // Each corner is an L-shape built from a horizontal and a vertical bar.
  // The bars share a rounded "knee" by using matching border radii.
  const isTop = position === "tl" || position === "tr";
  const isLeft = position === "tl" || position === "bl";

  const horizontalStyle = {
    position: "absolute" as const,
    width: CORNER_LENGTH,
    height: CORNER_THICKNESS,
    backgroundColor: "#ffffff",
    top: isTop ? 0 : undefined,
    bottom: isTop ? undefined : 0,
    left: isLeft ? 0 : undefined,
    right: isLeft ? undefined : 0,
    borderTopLeftRadius: isTop && isLeft ? CORNER_THICKNESS : 0,
    borderTopRightRadius: isTop && !isLeft ? CORNER_THICKNESS : 0,
    borderBottomLeftRadius: !isTop && isLeft ? CORNER_THICKNESS : 0,
    borderBottomRightRadius: !isTop && !isLeft ? CORNER_THICKNESS : 0,
  };

  const verticalStyle = {
    position: "absolute" as const,
    width: CORNER_THICKNESS,
    height: CORNER_LENGTH,
    backgroundColor: "#ffffff",
    top: isTop ? 0 : undefined,
    bottom: isTop ? undefined : 0,
    left: isLeft ? 0 : undefined,
    right: isLeft ? undefined : 0,
    borderTopLeftRadius: isTop && isLeft ? CORNER_THICKNESS : 0,
    borderTopRightRadius: isTop && !isLeft ? CORNER_THICKNESS : 0,
    borderBottomLeftRadius: !isTop && isLeft ? CORNER_THICKNESS : 0,
    borderBottomRightRadius: !isTop && !isLeft ? CORNER_THICKNESS : 0,
  };

  const containerStyle = {
    position: "absolute" as const,
    width: CORNER_LENGTH,
    height: CORNER_LENGTH,
    top: isTop ? -CORNER_THICKNESS : undefined,
    bottom: isTop ? undefined : -CORNER_THICKNESS,
    left: isLeft ? -CORNER_THICKNESS : undefined,
    right: isLeft ? undefined : -CORNER_THICKNESS,
  };

  return (
    <View style={containerStyle}>
      <View style={horizontalStyle} />
      <View style={verticalStyle} />
    </View>
  );
}

interface ScanLineProps {
  color: string;
  active: boolean;
}

function ScanLine({ color, active }: ScanLineProps) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (active) {
      progress.value = 0;
      progress.value = withRepeat(
        withTiming(1, {
          duration: SCAN_LINE_DURATION_MS,
          easing: Easing.inOut(Easing.ease),
        }),
        -1,
        true,
      );
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
    return () => {
      cancelAnimation(progress);
    };
  }, [active, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const travel = FRAME_SIZE - SCAN_LINE_INSET * 2 - SCAN_LINE_HEIGHT;
    return {
      transform: [{ translateY: progress.value * travel }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: SCAN_LINE_INSET,
          right: SCAN_LINE_INSET,
          top: SCAN_LINE_INSET,
          height: SCAN_LINE_HEIGHT,
          backgroundColor: color,
          borderRadius: SCAN_LINE_HEIGHT,
          shadowColor: color,
          shadowOpacity: 0.8,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 0 },
        },
        animatedStyle,
      ]}
    />
  );
}

export function QRScanner({
  visible,
  onScan,
  onClose,
  accepts = ALL_SCANNED_KINDS,
}: QRScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const handleBarCodeScanned = useCallback(
    (result: { data: string }) => {
      if (scanned) return;

      const code = parseScannedData(result.data);
      // An unparseable code, or one this caller cannot act on, leaves the
      // scanner running rather than closing it on a no-op.
      if (!code || !accepts.includes(code.kind)) return;

      setScanned(true);
      onScan(code);
      onClose();
      // Reset scanned state after modal closes
      setTimeout(() => setScanned(false), 500);
    },
    [scanned, onScan, onClose, accepts],
  );

  const handleClose = useCallback(() => {
    setScanned(false);
    setTorchOn(false);
    onClose();
  }, [onClose]);

  const toggleTorch = useCallback(() => {
    setTorchOn((prev) => !prev);
  }, []);

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const topInset = Math.max(insets.top, 16);
  const bottomInset = Math.max(insets.bottom, 24);
  const cameraReady = permission?.granted === true;

  // Precompute the absolute coordinates of the scan frame on screen so
  // the 4 dimmer bands can be positioned exactly around it without
  // relying on percentage-based offsets that don't compose with margins.
  const frame = useMemo(() => {
    const frameTop = Math.round((screenHeight - FRAME_SIZE) / 2);
    const frameLeft = Math.round((screenWidth - FRAME_SIZE) / 2);
    return {
      top: frameTop,
      left: frameLeft,
      bottom: frameTop + FRAME_SIZE,
      right: frameLeft + FRAME_SIZE,
    };
  }, [screenWidth, screenHeight]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View className="flex-1 bg-black">
        {permission === null ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-white text-base">
              {t("qrScanner.checking")}
            </Text>
          </View>
        ) : !permission.granted ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="w-full max-w-sm rounded-3xl bg-white/5 p-6 items-center">
              <View className="w-14 h-14 rounded-full bg-white/10 items-center justify-center mb-4">
                <MaterialCommunityIcons
                  name="camera-off-outline"
                  size={28}
                  color="#ffffff"
                />
              </View>
              <Text className="text-white text-base text-center mb-6">
                {t("qrScanner.permissionPrompt")}
              </Text>
              <Button
                title={t("qrScanner.grantCta")}
                onPress={requestPermission}
                variant="primary"
              />
            </View>
          </View>
        ) : (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            enableTorch={torchOn}
            barcodeScannerSettings={{
              barcodeTypes: ["qr"],
            }}
            onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          />
        )}

        {cameraReady ? (
          <View pointerEvents="box-none" className="absolute inset-0">
            {/* Dimmer bands: 4 views masking everything outside the frame */}
            <View
              pointerEvents="none"
              className="absolute bg-black/60"
              style={{ top: 0, left: 0, right: 0, height: frame.top }}
            />
            <View
              pointerEvents="none"
              className="absolute bg-black/60"
              style={{ top: frame.bottom, left: 0, right: 0, bottom: 0 }}
            />
            <View
              pointerEvents="none"
              className="absolute bg-black/60"
              style={{
                top: frame.top,
                height: FRAME_SIZE,
                left: 0,
                width: frame.left,
              }}
            />
            <View
              pointerEvents="none"
              className="absolute bg-black/60"
              style={{
                top: frame.top,
                height: FRAME_SIZE,
                left: frame.right,
                right: 0,
              }}
            />

            {/* Scan frame centered on screen */}
            <View
              pointerEvents="none"
              className="absolute"
              style={{
                top: frame.top,
                left: frame.left,
                width: FRAME_SIZE,
                height: FRAME_SIZE,
                borderRadius: CORNER_RADIUS,
              }}
            >
              <CornerIndicator position="tl" />
              <CornerIndicator position="tr" />
              <CornerIndicator position="bl" />
              <CornerIndicator position="br" />
              <ScanLine color={theme.colors.primary} active={!scanned} />
            </View>

            {/* Top title block */}
            <View
              pointerEvents="none"
              className="absolute left-0 right-0 items-center px-6"
              style={{ top: topInset + 12 }}
            >
              <Text className="text-white text-lg font-medium">
                {t("qrScanner.title")}
              </Text>
              <Text className="text-white/70 text-sm mt-1 text-center">
                {t("qrScanner.subtitle")}
              </Text>
            </View>

            {/* Top-right close button */}
            <Pressable
              onPress={handleClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t("qrScanner.closeAccessibility")}
              className="absolute w-11 h-11 rounded-full bg-white/10 items-center justify-center"
              style={{ top: topInset + 4, right: 16 }}
            >
              <MaterialCommunityIcons
                name="close"
                size={24}
                color="#ffffff"
              />
            </Pressable>

            {/* Bottom torch toggle */}
            <View
              pointerEvents="box-none"
              className="absolute left-0 right-0 items-center"
              style={{ bottom: bottomInset + 32 }}
            >
              <Pressable
                onPress={toggleTorch}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={
                  torchOn
                    ? t("qrScanner.torchOffAccessibility")
                    : t("qrScanner.torchOnAccessibility")
                }
                className={`w-12 h-12 rounded-full items-center justify-center ${
                  torchOn ? "bg-white" : "bg-white/10"
                }`}
              >
                <MaterialCommunityIcons
                  name={torchOn ? "flashlight-off" : "flashlight"}
                  size={24}
                  color={torchOn ? "#000000" : "#ffffff"}
                />
              </Pressable>
            </View>
          </View>
        ) : (
          /* When camera isn't available, we still need the close button */
          <Pressable
            onPress={handleClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t("qrScanner.closeAccessibility")}
            className="absolute w-11 h-11 rounded-full bg-white/10 items-center justify-center"
            style={{ top: topInset + 4, right: 16 }}
          >
            <MaterialCommunityIcons name="close" size={24} color="#ffffff" />
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

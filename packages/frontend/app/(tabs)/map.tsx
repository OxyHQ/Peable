/**
 * Places that accept FairCoin — native map screen (iOS + Android).
 *
 * Layout (Revolut / Google Maps inspired):
 *
 *  - Full-bleed map filling the viewport behind everything.
 *  - Floating pill search bar at the top-safe-area with a back button + text
 *    input. `bg-background` with `rounded-full` and a soft shadow.
 *  - Circular "my location" FAB bottom-right above the bottom sheet. Permission
 *    is requested lazily on first tap.
 *  - Bottom sheet card docked at the bottom with a drag handle, section title,
 *    and a horizontally-scrolling list of place cards. Tapping a card animates
 *    the camera and highlights the selection; tapping a marker does the same.
 *
 * Map implementation:
 *  - Uses `@maplibre/maplibre-react-native` (MapLibre Native v10) on both iOS
 *    and Android — a single open-source SDK forked from Mapbox GL that
 *    delivers a consistent look across platforms with no access token, no
 *    usage limits, and no proprietary vendor lock-in.
 *  - Web / Electron is routed to `map.web.tsx` via Metro's platform-specific
 *    file resolution. `@maplibre/maplibre-react-native` does not support web.
 *  - Tiles come from Carto (https://carto.com/basemaps) — free, public
 *    vector-tile provider that hosts the MapLibre `liberty` and `dark-matter`
 *    styles with no API key and no rate limits. The `liberty` style includes
 *    a `building-3d` extrusion layer that renders 3D buildings at high zoom.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  Image,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import BottomSheet, {
  BottomSheetScrollView,
  useBottomSheetScrollableCreator,
} from "@gorhom/bottom-sheet";
import { FlashList } from "@shopify/flash-list";
import {
  MapView,
  Camera,
  ShapeSource,
  CircleLayer,
  SymbolLayer,
  setAccessToken,
  type CameraRef,
  type OnPressEvent,
  type CircleLayerStyle,
  type SymbolLayerStyle,
} from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { t } from "../../src/i18n";
import {
  PLACES,
  distanceKm,
  formatDistanceKm,
  type FiatPayoutMethod,
  type Place,
  type PlaceCategory,
} from "../../src/data/places";
import { EmptyState } from "../../src/ui/components/EmptyState";
import { hapticSelection } from "../../src/utils/haptics";
import { COIN_TICKER } from "@fairco.in/core";

// ---------------------------------------------------------------------------
// MapLibre access token
// ---------------------------------------------------------------------------

// MapLibre is open-source but the native module still expects
// `setAccessToken` to run once at module load. `null` is the documented
// opt-out; the promise is intentionally not awaited.
void setAccessToken(null);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

// MapLibre / Mapbox / GeoJSON use `[longitude, latitude]` positions.
type Position = [number, number];

interface UserCoords {
  latitude: number;
  longitude: number;
}

type SheetMode = "list" | "detail";

type CategoryFilter = PlaceCategory | "all";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Carto basemap style URLs — free, public, no API key, no rate limits.
// https://github.com/CartoDB/basemap-styles
const MAP_STYLE_LIGHT =
  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const MAP_STYLE_DARK =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const INITIAL_ZOOM = 5;
const INITIAL_PITCH = 0;
const CAMERA_ANIMATION_MS = 500;

// Half-width in degrees of the bounding box passed to `fitBounds`. ~0.002°
// (≈220m) resolves to approximately zoom 16 on a typical phone — tight
// enough for "street view" without clipping the marker at viewport edges.
const PLACE_BOUNDS_HALF_DEGREES = 0.002;

// Hit area for native ShapeSource taps. MapLibre defaults to 44×44; we use
// 50×50 so taps feel forgiving even when a pin is small at low zoom.
const MARKER_HITBOX = { width: 50, height: 50 } as const;

// Snap points for the sheet. Index 0 = 15% peek (mostly map). Index 1 =
// 62% mid — the Google-Maps-style "selected place" height where the hero
// image, facts, and action row are visible. Index 2 = 100% — the sheet
// fills the screen all the way up behind the notch, sliding under the
// floating search pill. Magnetic snapping pulls a flick past mid
// straight to the top.
const SHEET_SNAP_POINTS: (string | number)[] = ["15%", "62%", "100%"];
const SHEET_INDEX_MID = 1;
const SHEET_INDEX_TOP = 2;

const LIST_CONTENT_CONTAINER_STYLE = { paddingBottom: 24 } as const;

// Fallback map center when PLACES is empty (Madrid).
const FALLBACK_CENTER: Position = [-3.7038, 40.4168];

const INITIAL_CENTER: Position = PLACES[0]
  ? [PLACES[0].longitude, PLACES[0].latitude]
  : FALLBACK_CENTER;

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

const CATEGORY_ICON: Record<PlaceCategory, IconName> = {
  cafe: "coffee",
  restaurant: "silverware-fork-knife",
  shop: "storefront",
  service: "tools",
  atm: "cash-multiple",
  other: "map-marker",
};

// Per-category palette for the native CircleLayer that renders pins.
// High-contrast hues so each category is recognisable at a glance, matching
// Google Maps' conventions.
const CATEGORY_COLOR: Record<PlaceCategory, string> = {
  cafe: "#78350f",
  restaurant: "#dc2626",
  shop: "#2563eb",
  service: "#7c3aed",
  atm: "#16a34a",
  other: "#6b7280",
};

// `match` expression driving `circleColor`, derived once from CATEGORY_COLOR
// so adding a new PlaceCategory only requires extending the record above.
const CATEGORY_COLOR_EXPRESSION = [
  "match",
  ["get", "category"],
  ...(Object.entries(CATEGORY_COLOR) as [PlaceCategory, string][]).flatMap(
    ([cat, color]) => [cat, color],
  ),
  CATEGORY_COLOR.other,
] as const;

// Order of chips in the Google-Maps-style filter row at the top of the
// sheet. `all` is the initial/reset state.
const CATEGORY_FILTERS: readonly CategoryFilter[] = [
  "all",
  "cafe",
  "restaurant",
  "shop",
  "service",
  "atm",
  "other",
] as const;

// Stable MapLibre sub-expression reused by the selected-state filter so the
// inner `["get", "id"]` array isn't reallocated on every selection change.
const GET_ID_EXPR = ["get", "id"] as const;

function categoryLabel(category: PlaceCategory): string {
  return t(`map.category.${category}`);
}

function fiatPayoutLabel(method: FiatPayoutMethod): string {
  return t(`map.detail.payoutMethod.${method}`);
}

// We always suppress gorhom's chrome handle. In detail mode the hero
// image paints its own translucent handle bar. In list mode `FloatingHandle`
// renders an absolute-positioned handle on top of the scrollable content
// so scrolled rows pass visually behind the handle (Google Maps UX).
function renderNullHandle(): null {
  return null;
}

// Transparent overlay handle pinned to the top of the sheet content area.
// Scrollable rows pass behind it, matching Google Maps' behaviour where
// the grab handle floats above the list.
function FloatingHandle() {
  return (
    <View pointerEvents="none" style={styles.floatingHandle}>
      <View style={styles.floatingHandleBar} />
    </View>
  );
}

// Drop shadow underneath every pin. Uses `circleBlur` for a soft edge and
// `circleTranslate` in viewport space so the shadow always drops straight
// down on screen regardless of map rotation.
const PLACES_SHADOW_STYLE: CircleLayerStyle = {
  circleRadius: [
    "interpolate",
    ["linear"],
    ["zoom"],
    10, 5,
    14, 7,
    16, 10,
    18, 14,
  ],
  circleColor: "rgba(0,0,0,0.35)",
  circleBlur: 0.8,
  circleTranslate: [0, 2],
  circleTranslateAnchor: "viewport",
  circlePitchAlignment: "map",
};

// Base pin circle. Zoom-interpolated radius + native `match` on category.
const PLACES_CIRCLE_STYLE: CircleLayerStyle = {
  circleRadius: [
    "interpolate",
    ["linear"],
    ["zoom"],
    10, 4,
    14, 6,
    16, 9,
    18, 12,
  ],
  circleColor: CATEGORY_COLOR_EXPRESSION,
  circleStrokeColor: "#ffffff",
  circleStrokeWidth: 2.5,
  circlePitchAlignment: "map",
};

// Small white glossy highlight on the selected pin. Offset in viewport
// space so it's always top-left of the pin regardless of rotation.
const PLACES_SELECTED_HIGHLIGHT_STYLE: CircleLayerStyle = {
  circleRadius: [
    "interpolate",
    ["linear"],
    ["zoom"],
    10, 2,
    14, 3,
    16, 4,
    18, 5,
  ],
  circleColor: "rgba(255,255,255,0.9)",
  circleTranslate: [-2, -2],
  circleTranslateAnchor: "viewport",
  circlePitchAlignment: "map",
};

// Google Maps directions URL — on iOS opens the Google Maps app if
// installed (Safari + Apple Maps fallback otherwise), on Android opens
// Google Maps directly, on web opens a browser tab.
function openDirections(place: Place): void {
  const destination = `${place.latitude},${place.longitude}`;
  const label = encodeURIComponent(place.name);
  const url = `https://www.google.com/maps/dir/?api=1&destination=${destination}&destination_place_id=${label}&travelmode=driving`;
  void Linking.openURL(url);
}

function formatDistanceLabel(km: number | null): string | null {
  return km !== null ? t("map.distance", { km: formatDistanceKm(km) }) : null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function MapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();

  const cameraRef = useRef<CameraRef>(null);
  const sheetRef = useRef<BottomSheet>(null);
  const locationDeniedPrompt = useDialogControl();

  // Official replacement (gorhom v5) for the deprecated BottomSheetFlashList
  // wrapper: a `renderScrollComponent` that wires FlashList into the sheet's
  // gesture coordination.
  const BottomSheetFlashListScrollable = useBottomSheetScrollableCreator();

  // Fractional sheet snap index fed live to gorhom via `animatedIndex`.
  // Drives the drag-synchronised top spacer inside the list header so the
  // first row slides smoothly down as the sheet expands behind the search
  // pill, matching Google Maps UX.
  const sheetAnimatedIndex = useSharedValue(SHEET_INDEX_MID);

  // Vertical space occupied by the floating search pill (safe-area top +
  // pill top margin + pill height + breathing room). The sheet is free to
  // slide *behind* the pill when expanded; this value is applied as the
  // sheet's content `paddingTop` at the expanded snap so the first list
  // row is visible just below the pill, exactly like Google Maps.
  const sheetTopInset = insets.top + 10 + 56 + 8;

  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>(
    PLACES[0]?.id ?? "",
  );
  const [sheetMode, setSheetMode] = useState<SheetMode>("list");
  const [sheetIndex, setSheetIndex] = useState<number>(SHEET_INDEX_MID);
  const [userLocation, setUserLocation] = useState<UserCoords | null>(null);

  // No `onBlur` handler: re-snapping on blur triggers another keyboard
  // lifecycle event which blurs the TextInput again, creating a
  // focus-blur oscillation.
  const handleSearchFocus = useCallback(() => {
    sheetRef.current?.snapToIndex(SHEET_INDEX_TOP);
  }, []);

  const handleCategoryFilter = useCallback((next: CategoryFilter) => {
    hapticSelection();
    setCategoryFilter(next);
  }, []);

  // Padding ordered [top, right, bottom, left] per the fitBounds signature.
  // The top inset clears the floating search pill; the bottom inset matches
  // the mid sheet snap so the camera target lands above the sheet.
  const fitPadding = useMemo<[number, number, number, number]>(
    () => [insets.top + 80, 0, Math.round(windowHeight * 0.62), 0],
    [insets.top, windowHeight],
  );

  const filteredPlaces = useMemo<readonly Place[]>(() => {
    const trimmed = query.trim().toLowerCase();
    return PLACES.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) {
        return false;
      }
      if (!trimmed) return true;
      return (
        p.name.toLowerCase().includes(trimmed) ||
        p.city.toLowerCase().includes(trimmed) ||
        p.country.toLowerCase().includes(trimmed) ||
        p.address.toLowerCase().includes(trimmed) ||
        categoryLabel(p.category).toLowerCase().includes(trimmed)
      );
    });
  }, [query, categoryFilter]);

  const placesGeoJson = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      type: "FeatureCollection",
      features: filteredPlaces.map((place) => ({
        type: "Feature",
        id: place.id,
        geometry: {
          type: "Point",
          coordinates: [place.longitude, place.latitude],
        },
        properties: {
          id: place.id,
          name: place.name,
          category: place.category,
        },
      })),
    }),
    [filteredPlaces],
  );

  // fitBounds is the only camera-padding path the library guarantees works
  // on both iOS and Android (routed via native `getCameraForLatLngBounds`).
  const animateToCoordinate = useCallback(
    (latitude: number, longitude: number) => {
      const ne: Position = [
        longitude + PLACE_BOUNDS_HALF_DEGREES,
        latitude + PLACE_BOUNDS_HALF_DEGREES,
      ];
      const sw: Position = [
        longitude - PLACE_BOUNDS_HALF_DEGREES,
        latitude - PLACE_BOUNDS_HALF_DEGREES,
      ];
      cameraRef.current?.fitBounds(ne, sw, fitPadding, CAMERA_ANIMATION_MS);
    },
    [fitPadding],
  );

  const selectPlace = useCallback(
    (place: Place, shouldAnimateCamera: boolean) => {
      hapticSelection();
      setSelectedPlaceId(place.id);
      setSheetMode("detail");
      sheetRef.current?.snapToIndex(SHEET_INDEX_MID);
      if (shouldAnimateCamera) {
        animateToCoordinate(place.latitude, place.longitude);
      }
    },
    [animateToCoordinate],
  );

  const handleMarkerPress = useCallback(
    (event: OnPressEvent) => {
      const feature = event.features[0];
      const id = feature?.properties?.id;
      if (typeof id !== "string") return;
      const place = PLACES.find((p) => p.id === id);
      if (place) {
        selectPlace(place, true);
      }
    },
    [selectPlace],
  );

  const handleCloseDetail = useCallback(() => {
    setSheetMode("list");
  }, []);

  const handleSheetChange = useCallback((index: number) => {
    setSheetIndex((prev) => (prev === index ? prev : index));
  }, []);

  // Animated height for the spacer that sits at the very top of the list
  // header. Grows from 0 → sheetTopInset as the sheet's snap index moves
  // from mid (1) toward expanded (2), so the first visible row slides
  // down in lockstep with the sheet clearing the search pill.
  const headerSpacerStyle = useAnimatedStyle(() => ({
    height: interpolate(
      sheetAnimatedIndex.get(),
      [SHEET_INDEX_MID, SHEET_INDEX_TOP],
      [0, sheetTopInset],
      Extrapolation.CLAMP,
    ),
  }));

  const selectedPlace = useMemo<Place | null>(
    () => PLACES.find((p) => p.id === selectedPlaceId) ?? null,
    [selectedPlaceId],
  );

  const handleLocateMe = useCallback(async () => {
    try {
      const existing = await Location.getForegroundPermissionsAsync();
      let status = existing.status;

      if (status !== "granted") {
        const requested = await Location.requestForegroundPermissionsAsync();
        status = requested.status;
      }

      if (status !== "granted") {
        locationDeniedPrompt.open();
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords: UserCoords = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      setUserLocation(coords);
      animateToCoordinate(coords.latitude, coords.longitude);
    } catch {
      // expo-location rejects for permission denied, services disabled, or
      // timeout — surface the same dialog for all of them.
      locationDeniedPrompt.open();
    }
  }, [animateToCoordinate, locationDeniedPrompt]);

  // ---- Distance per place, sorted by proximity if we have user location ----
  const placesWithDistance = useMemo(() => {
    return filteredPlaces.map((place) => {
      const km = userLocation
        ? distanceKm(userLocation, {
            latitude: place.latitude,
            longitude: place.longitude,
          })
        : null;
      return { place, km };
    });
  }, [filteredPlaces, userLocation]);

  // ---- Distance for the currently-selected place, used by the detail view.
  const selectedPlaceDistanceKm = useMemo<number | null>(() => {
    if (!selectedPlace || !userLocation) return null;
    return distanceKm(userLocation, {
      latitude: selectedPlace.latitude,
      longitude: selectedPlace.longitude,
    });
  }, [selectedPlace, userLocation]);

  const mapStyleUrl = theme.isDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;

  // Selection ring and selected-label depend on the theme primary so they
  // can't be hoisted; the base pin / shadow / highlight styles live at
  // module scope at the top of the file.
  const placesSelectedStyle = useMemo<CircleLayerStyle>(
    () => ({
      circleRadius: [
        "interpolate", ["linear"], ["zoom"],
        10, 6,
        14, 9,
        16, 13,
        18, 16,
      ],
      circleColor: theme.colors.primary,
      circleStrokeColor: "#ffffff",
      circleStrokeWidth: 3,
      circlePitchAlignment: "map",
    }),
    [theme.colors.primary],
  );

  // `textAllowOverlap: false` lets MapLibre declutter colliding labels as
  // the user zooms out (Google Maps collision avoidance).
  const placesLabelStyle = useMemo<SymbolLayerStyle>(
    () => ({
      textField: ["get", "name"],
      textSize: [
        "interpolate", ["linear"], ["zoom"],
        11, 0,
        12, 10,
        14, 11,
        16, 12,
        18, 14,
      ],
      textColor: theme.colors.text,
      textHaloColor: theme.colors.background,
      textHaloWidth: 2,
      textOffset: [0, 1.4],
      textAnchor: "top",
      textAllowOverlap: false,
      textIgnorePlacement: false,
      textPitchAlignment: "viewport",
      textMaxWidth: 8,
    }),
    [theme.colors.text, theme.colors.background],
  );

  const placesSelectedLabelStyle = useMemo<SymbolLayerStyle>(
    () => ({
      textField: ["get", "name"],
      textSize: 14,
      textColor: theme.colors.primary,
      textHaloColor: theme.colors.background,
      textHaloWidth: 2.5,
      textOffset: [0, 1.6],
      textAnchor: "top",
      textAllowOverlap: true,
      textIgnorePlacement: true,
      textPitchAlignment: "viewport",
      textMaxWidth: 10,
    }),
    [theme.colors.primary, theme.colors.background],
  );

  // Only `selectedPlaceId` varies — the inner `["get", "id"]` is a stable
  // module constant (`GET_ID_EXPR`) so we don't reallocate it per render.
  const placesSelectedFilter = useMemo(
    () => ["==", GET_ID_EXPR, selectedPlaceId] as const,
    [selectedPlaceId],
  );

  const sheetBackgroundStyle = useMemo(
    () => ({
      backgroundColor: theme.colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      overflow: "hidden" as const,
    }),
    [theme.colors.background],
  );

  // Search pill wrapper depends on the safe-area inset so it's memoised;
  // the FAB container style is a StyleSheet entry (see `styles.fabContainer`).
  const searchPillBaseStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: insets.top + 10,
      left: 0,
      right: 0,
      paddingHorizontal: 12,
      zIndex: 10,
    }),
    [insets.top],
  );

  // When the sheet reaches its fully-expanded snap, swap the pill's drop
  // shadow for a hairline border. A shadow against the sheet (which is now
  // flush with the pill) reads as grime; a border separates the pill from
  // the sheet cleanly.
  const pillSurfaceStyle = useMemo(() => {
    if (sheetIndex >= SHEET_INDEX_TOP) {
      return {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
      };
    }
    return styles.floatingBar;
  }, [sheetIndex, theme.colors.border]);

  const renderPlaceRow = useCallback(
    ({ item }: { item: { place: Place; km: number | null } }) => (
      <PlaceRow
        place={item.place}
        distanceKm={item.km}
        isSelected={item.place.id === selectedPlaceId}
        onPress={() => selectPlace(item.place, true)}
      />
    ),
    [selectedPlaceId, selectPlace],
  );

  // User-location marker rendered from expo-location coords via a ShapeSource +
  // CircleLayer, instead of MapLibre's native `UserLocation` — that component's
  // location module calls `getReactNativeHost()` on every fix, which throws
  // under the New Architecture ("You should not use ReactNativeHost directly").
  const userLocationFeature = useMemo<GeoJSON.Feature<GeoJSON.Point> | null>(
    () =>
      userLocation
        ? {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: [userLocation.longitude, userLocation.latitude],
            },
          }
        : null,
    [userLocation],
  );

  const userDotStyle = useMemo<CircleLayerStyle>(
    () => ({
      circleRadius: 7,
      circleColor: theme.colors.primary,
      circleStrokeWidth: 3,
      circleStrokeColor: "#ffffff",
    }),
    [theme.colors.primary],
  );

  const userHaloStyle = useMemo<CircleLayerStyle>(
    () => ({
      circleRadius: 16,
      circleColor: theme.colors.primary,
      circleOpacity: 0.18,
    }),
    [theme.colors.primary],
  );

  return (
    <View className="flex-1 bg-background">
      {/* ---- Full-bleed native map ---- */}
      <MapView
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyleUrl}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled
      >
        <Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: INITIAL_CENTER,
            zoomLevel: INITIAL_ZOOM,
            pitch: INITIAL_PITCH,
            heading: 0,
          }}
        />
        {userLocationFeature ? (
          <ShapeSource id="user-location-source" shape={userLocationFeature}>
            <CircleLayer id="user-location-halo" style={userHaloStyle} />
            <CircleLayer id="user-location-dot" style={userDotStyle} />
          </ShapeSource>
        ) : null}

        {/* Native place pins. One ShapeSource feeds every layer so the
            native hit-test dispatches onPress for taps on any visible
            layer. Layer order bottom→top: shadow, base pin, selected
            ring, selected highlight, base label, selected label. */}
        <ShapeSource
          id="places-source"
          shape={placesGeoJson}
          onPress={handleMarkerPress}
          hitbox={MARKER_HITBOX}
        >
          <CircleLayer id="places-shadow" style={PLACES_SHADOW_STYLE} />
          <CircleLayer id="places-circles" style={PLACES_CIRCLE_STYLE} />
          <CircleLayer
            id="places-circles-selected"
            filter={placesSelectedFilter}
            style={placesSelectedStyle}
          />
          <CircleLayer
            id="places-circles-highlight"
            filter={placesSelectedFilter}
            style={PLACES_SELECTED_HIGHLIGHT_STYLE}
          />
          <SymbolLayer id="places-labels" style={placesLabelStyle} />
          <SymbolLayer
            id="places-labels-selected"
            filter={placesSelectedFilter}
            style={placesSelectedLabelStyle}
          />
        </ShapeSource>
      </MapView>

      <View pointerEvents="box-none" style={searchPillBaseStyle}>
        <View
          className="flex-row items-center bg-surface rounded-full pl-2 pr-3 h-14"
          style={pillSurfaceStyle}
        >
          <Pressable
            onPress={() => router.back()}
            className="w-11 h-11 items-center justify-center rounded-full active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
            hitSlop={8}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={22}
              color={theme.colors.text}
            />
          </Pressable>

          <TextInput
            value={query}
            onChangeText={setQuery}
            onFocus={handleSearchFocus}
            placeholder={t("map.searchPlaceholder")}
            placeholderTextColor={theme.colors.textSecondary}
            className="flex-1 ml-1 mr-2 text-base"
            style={{ color: theme.colors.text }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />

          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery("")}
              className="w-8 h-8 items-center justify-center rounded-full active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel={t("common.clear")}
              hitSlop={6}
            >
              <MaterialCommunityIcons
                name="close"
                size={18}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          ) : (
            <MaterialCommunityIcons
              name="magnify"
              size={22}
              color={theme.colors.textSecondary}
            />
          )}
        </View>
      </View>

      <View pointerEvents="box-none" style={styles.fabContainer}>
        <Pressable
          onPress={handleLocateMe}
          className="w-12 h-12 rounded-full bg-surface items-center justify-center active:opacity-80"
          style={styles.fab}
          accessibilityRole="button"
          accessibilityLabel={t("map.locateMe.accessibility")}
        >
          <MaterialCommunityIcons
            name="crosshairs-gps"
            size={22}
            color={theme.colors.primary}
          />
        </Pressable>
      </View>

      <BottomSheet
        ref={sheetRef}
        snapPoints={SHEET_SNAP_POINTS}
        index={1}
        enablePanDownToClose={false}
        enableDynamicSizing={false}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onChange={handleSheetChange}
        animatedIndex={sheetAnimatedIndex}
        backgroundStyle={sheetBackgroundStyle}
        handleComponent={renderNullHandle}
      >
        {sheetMode === "detail" && selectedPlace ? (
          <PlaceDetail
            place={selectedPlace}
            distanceKm={selectedPlaceDistanceKm}
            onClose={handleCloseDetail}
          />
        ) : (
          <>
            <FlashList
              renderScrollComponent={BottomSheetFlashListScrollable}
              data={placesWithDistance}
              keyExtractor={(item) => item.place.id}
              contentContainerStyle={LIST_CONTENT_CONTAINER_STYLE}
              showsVerticalScrollIndicator={false}
              ListHeaderComponent={
                <View>
                  <Animated.View style={headerSpacerStyle} />
                  <View className="px-5 pt-4 pb-2">
                    <Text className="text-foreground text-lg font-semibold">
                      {t("map.nearYou")}
                    </Text>
                    <Text className="text-muted-foreground text-xs mt-0.5">
                      {filteredPlaces.length}{" "}
                      {filteredPlaces.length === 1
                        ? t("map.resultOne")
                        : t("map.resultOther")}
                    </Text>
                  </View>
                  <CategoryFilterRow
                    value={categoryFilter}
                    onChange={handleCategoryFilter}
                  />
                </View>
              }
              ListEmptyComponent={
                <EmptyState icon="map-marker-off" title={t("map.noResults")} />
              }
              renderItem={renderPlaceRow}
            />
            <FloatingHandle />
          </>
        )}
      </BottomSheet>

      <Dialog
        control={locationDeniedPrompt}
        placement="bottom"
        title={t("map.permissionDenied.title")}
        description={t("map.permissionDenied.subtitle")}
        actions={[{ label: t("common.ok") }]}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// CategoryFilterRow — horizontal scrollable chip row that filters the list
// by PlaceCategory. Rendered as a sibling of the FlashList (not inside it)
// so it stays sticky at the top of the sheet while the list scrolls under.
// ---------------------------------------------------------------------------

interface CategoryFilterRowProps {
  value: CategoryFilter;
  onChange: (next: CategoryFilter) => void;
}

function CategoryFilterRow({ value, onChange }: CategoryFilterRowProps) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {CATEGORY_FILTERS.map((key) => {
        const isActive = key === value;
        const label =
          key === "all" ? t("map.filter.all") : categoryLabel(key);
        const icon: IconName =
          key === "all" ? "filter-variant" : CATEGORY_ICON[key];
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            className={`flex-row items-center rounded-full px-3 h-9 mr-2 border ${
              isActive ? "border-transparent" : ""
            }`}
            style={[
              styles.chip,
              isActive
                ? { backgroundColor: theme.colors.primary }
                : {
                    backgroundColor: theme.colors.background,
                    borderColor: theme.colors.border,
                  },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            hitSlop={6}
          >
            <MaterialCommunityIcons
              name={icon}
              size={16}
              color={isActive ? "#ffffff" : theme.colors.textSecondary}
            />
            <Text
              className="ml-1.5 text-sm font-medium"
              style={{ color: isActive ? "#ffffff" : theme.colors.text }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// PlaceRow — vertical row for the FlashList in the bottom sheet (Google Maps
// style: avatar + name + meta lines + distance pill on the right).
// ---------------------------------------------------------------------------

interface PlaceRowProps {
  place: Place;
  distanceKm: number | null;
  isSelected: boolean;
  onPress: () => void;
}

const PlaceRow = memo(function PlaceRow({
  place,
  distanceKm: km,
  isSelected,
  onPress,
}: PlaceRowProps) {
  const theme = useTheme();
  const icon = CATEGORY_ICON[place.category];
  const distanceLabel = formatDistanceLabel(km);

  const handleDirectionsPress = useCallback(() => {
    hapticSelection();
    openDirections(place);
  }, [place]);

  return (
    <Pressable
      onPress={onPress}
      className={`px-5 py-3 ${
        isSelected ? "bg-primary/5" : "active:bg-surface"
      }`}
    >
      <View className="flex-row items-center">
        {place.imageUrl ? (
          <Image
            source={{ uri: place.imageUrl }}
            style={styles.rowThumbnail}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View className="w-14 h-14 rounded-xl bg-primary/10 items-center justify-center mr-3">
            <MaterialCommunityIcons
              name={icon}
              size={24}
              color={theme.colors.primary}
            />
          </View>
        )}

        <View className="flex-1 mr-2">
          <Text
            className="text-foreground text-base font-semibold"
            numberOfLines={1}
          >
            {place.name}
          </Text>
          <Text
            className="text-muted-foreground text-xs mt-0.5"
            numberOfLines={1}
          >
            {categoryLabel(place.category)} · {place.city}
          </Text>
          <Text
            className="text-muted-foreground text-xs mt-0.5"
            numberOfLines={1}
          >
            {place.address}
          </Text>
        </View>

        {distanceLabel ? (
          <View className="bg-surface rounded-full px-3 py-1 mr-2">
            <Text className="text-muted-foreground text-xs font-medium">
              {distanceLabel}
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={handleDirectionsPress}
          className="w-10 h-10 rounded-full bg-primary items-center justify-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel={t("map.directions.accessibility", {
            name: place.name,
          })}
          hitSlop={6}
        >
          <MaterialCommunityIcons
            name="directions"
            size={20}
            color="#ffffff"
          />
        </Pressable>
      </View>
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// PlaceDetail — Google Maps inspired place sheet: hero image, title block,
// distance chip, address, description and an action row (Directions + call
// and website icon buttons). Rendered inside `BottomSheetScrollView` so it
// scrolls naturally within the gesture-handling bottom sheet.
// ---------------------------------------------------------------------------

interface PlaceDetailProps {
  place: Place;
  distanceKm: number | null;
  onClose: () => void;
}

function PlaceDetail({ place, distanceKm: km, onClose }: PlaceDetailProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const distanceLabel = formatDistanceLabel(km);
  const heroIcon = CATEGORY_ICON[place.category];

  const handleDirections = useCallback(() => {
    hapticSelection();
    openDirections(place);
  }, [place]);

  const handleCall = useCallback(() => {
    const phone = place.phone;
    if (!phone) return;
    hapticSelection();
    void Linking.openURL(`tel:${phone}`);
  }, [place.phone]);

  const handleWebsite = useCallback(() => {
    const website = place.website;
    if (!website) return;
    hapticSelection();
    void Linking.openURL(website);
  }, [place.website]);

  const contentStyle = useMemo(
    () => ({ paddingBottom: insets.bottom + 16 }),
    [insets.bottom],
  );

  return (
    <BottomSheetScrollView
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero image (or tinted category fallback) — top corners are rounded
       * to match the parent sheet's rounded top. We clip the wrapper View
       * with `overflow: hidden` so the child <Image> and the overlaid drag
       * handle both inherit the rounded corners and the image bitmap
       * doesn't spill over the sheet's top edges. */}
      <View style={styles.heroWrapper}>
        {place.imageUrl ? (
          <Image
            source={{ uri: place.imageUrl }}
            style={styles.heroImage}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View className="w-full h-[200px] bg-primary/10 items-center justify-center">
            <MaterialCommunityIcons
              name={heroIcon}
              size={64}
              color={theme.colors.primary}
            />
          </View>
        )}
        {/* Custom drag handle overlayed on the hero image so the user can
         * still pan the sheet up/down even though the chrome handle is
         * suppressed in detail mode. */}
        <View
          pointerEvents="none"
          style={styles.heroHandleContainer}
        >
          <View style={styles.heroHandleBar} />
        </View>
        <Pressable
          onPress={onClose}
          className="absolute top-3 left-3 w-10 h-10 rounded-full bg-background/80 items-center justify-center active:opacity-80"
          style={styles.heroCloseButton}
          accessibilityRole="button"
          accessibilityLabel={t("map.detail.close.accessibility")}
          hitSlop={8}
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={22}
            color={theme.colors.text}
          />
        </Pressable>
      </View>

      {/* Title block */}
      <View className="px-5 pt-4 pb-2">
        <Text
          className="text-foreground text-2xl font-bold"
          numberOfLines={2}
        >
          {place.name}
        </Text>
        <Text className="text-muted-foreground text-sm mt-1">
          {categoryLabel(place.category)} · {place.city}, {place.country}
        </Text>
      </View>

      {/* Distance pill */}
      {distanceLabel ? (
        <View className="px-5 mb-2 flex-row items-center">
          <View className="bg-primary/10 rounded-full px-3 py-1">
            <Text className="text-primary text-xs font-semibold">
              {distanceLabel}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Address */}
      <View className="px-5 py-2 flex-row items-start">
        <MaterialCommunityIcons
          name="map-marker-outline"
          size={18}
          color={theme.colors.textSecondary}
          style={styles.addressIcon}
        />
        <Text className="text-foreground text-sm flex-1">{place.address}</Text>
      </View>

      {place.description ? (
        <View className="px-5 py-2">
          <Text className="text-foreground text-sm leading-5">
            {place.description}
          </Text>
        </View>
      ) : null}

      <PlaceFacts place={place} />

      <View className="px-5 pt-4 flex-row items-center gap-2">
        <Pressable
          onPress={handleDirections}
          className="flex-1 bg-primary rounded-full py-3 flex-row items-center justify-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel={t("map.detail.directions")}
        >
          <MaterialCommunityIcons
            name="directions"
            size={18}
            color="#ffffff"
          />
          <Text className="text-white font-semibold ml-2">
            {t("map.detail.directions")}
          </Text>
        </Pressable>

        {place.phone ? (
          <Pressable
            onPress={handleCall}
            className="w-12 h-12 rounded-full bg-surface items-center justify-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel={t("map.detail.call")}
          >
            <MaterialCommunityIcons
              name="phone"
              size={20}
              color={theme.colors.primary}
            />
          </Pressable>
        ) : null}

        {place.website ? (
          <Pressable
            onPress={handleWebsite}
            className="w-12 h-12 rounded-full bg-surface items-center justify-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel={t("map.detail.website")}
          >
            <MaterialCommunityIcons
              name="web"
              size={20}
              color={theme.colors.primary}
            />
          </Pressable>
        ) : null}
      </View>
    </BottomSheetScrollView>
  );
}

// ---------------------------------------------------------------------------
// PlaceFacts — structured key/value rows rendered in the place detail view
// for the extended metadata (minimum spend, FairCoin → local fiat exchange,
// payout methods, opening hours). Each row is only rendered when the
// corresponding field is populated on the Place.
// ---------------------------------------------------------------------------

function PlaceFacts({ place }: { place: Place }) {
  const theme = useTheme();
  const hasAnyFact =
    place.minimumSpend !== undefined ||
    place.acceptsFairToFiat ||
    place.openingHours !== undefined;
  if (!hasAnyFact) return null;

  return (
    <View className="px-5 pt-2">
      {place.minimumSpend !== undefined ? (
        <FactRow
          icon="cash-minus"
          label={t("map.detail.minimumSpend")}
          value={t("map.detail.minimumSpendValue", {
            amount: place.minimumSpend,
            ticker: COIN_TICKER,
          })}
          iconColor={theme.colors.textSecondary}
          labelColor={theme.colors.textSecondary}
          valueColor={theme.colors.text}
        />
      ) : null}

      {place.acceptsFairToFiat && place.localCurrency ? (
        <View className="mt-2">
          <FactRow
            icon="swap-horizontal-bold"
            label={t("map.detail.fiatExchange", {
              currency: place.localCurrency,
            })}
            value={
              place.maxFiatPayout !== undefined
                ? t("map.detail.maxFiatPayout", {
                    amount: place.maxFiatPayout,
                    currency: place.localCurrency,
                  })
                : undefined
            }
            iconColor={theme.colors.primary}
            labelColor={theme.colors.text}
            valueColor={theme.colors.textSecondary}
          />
          {place.fiatPayoutMethods && place.fiatPayoutMethods.length > 0 ? (
            <View className="flex-row flex-wrap mt-2 ml-7">
              {place.fiatPayoutMethods.map((method) => (
                <View
                  key={method}
                  className="bg-primary/10 rounded-full px-3 py-1 mr-2 mb-2"
                >
                  <Text className="text-primary text-xs font-semibold">
                    {fiatPayoutLabel(method)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {place.openingHours ? (
        <View className="mt-2">
          <FactRow
            icon="clock-outline"
            label={t("map.detail.openingHours")}
            value={place.openingHours}
            iconColor={theme.colors.textSecondary}
            labelColor={theme.colors.textSecondary}
            valueColor={theme.colors.text}
          />
        </View>
      ) : null}
    </View>
  );
}

interface FactRowProps {
  icon: IconName;
  label: string;
  value?: string;
  iconColor: string;
  labelColor: string;
  valueColor: string;
}

function FactRow({
  icon,
  label,
  value,
  iconColor,
  labelColor,
  valueColor,
}: FactRowProps) {
  return (
    <View className="flex-row items-start">
      <MaterialCommunityIcons
        name={icon}
        size={18}
        color={iconColor}
        style={styles.addressIcon}
      />
      <View className="flex-1">
        <Text className="text-sm font-medium" style={{ color: labelColor }}>
          {label}
        </Text>
        {value ? (
          <Text className="text-xs mt-0.5" style={{ color: valueColor }}>
            {value}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles (only values that can't be expressed as NativeWind classes)
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Matches Google Maps' search pill shadow on iOS (soft, wide, offset
  // slightly below) and Android (Material 3 elevation 8).
  floatingBar: {
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabContainer: {
    position: "absolute",
    right: 16,
    bottom: "42%",
    zIndex: 9,
  },
  fab: {
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  listContent: {
    paddingBottom: 24,
  },
  chipRow: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
  },
  chip: {
    borderWidth: 1,
  },
  floatingHandle: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  floatingHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(120, 120, 128, 0.55)",
  },
  heroHandleContainer: {
    position: "absolute",
    top: 8,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 2,
  },
  heroHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.85)",
  },
  // Row thumbnail: we express the sizing / radius in the StyleSheet so the
  // `<Image>` honours the exact rounded-square shape across Android, where
  // NativeWind's border-radius classes don't always apply to <Image>.
  rowThumbnail: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginRight: 12,
  },
  // Hero wrapper: rounds the top corners so the image (and the overlaid
  // drag handle) match the parent sheet's rounded shape. `overflow: hidden`
  // clips the image bitmap to the radius.
  heroWrapper: {
    position: "relative",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  // Hero image spans the sheet full-width and is clipped by the rounded
  // heroWrapper above. No radius on the Image itself — Android <Image>
  // ignores borderRadius on the `source` bitmap in some layouts, so we
  // rely on parent clipping instead.
  heroImage: {
    width: "100%",
    height: 200,
  },
  // The circular back button floating over the hero sits on top of arbitrary
  // imagery, so we add a subtle shadow here to keep it legible regardless of
  // the photo colours. The translucent fill itself comes from the NativeWind
  // `bg-background/80` class.
  heroCloseButton: {
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  // Tiny nudge so the map marker icon aligns with the first line of the
  // address Text. `mt-0.5 mr-2` classes don't compose onto MaterialCommunityIcons.
  addressIcon: {
    marginTop: 2,
    marginRight: 8,
  },
});

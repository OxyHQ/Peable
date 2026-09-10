/**
 * PriceSparkline — the Overview price hero: a big FAIR/USD price, a coloured 24h
 * change, and a full-bleed ~7d line chart (react-native-svg). Card-less and
 * spacious (Uniswap/Apple style).
 *
 * Degrades gracefully: no price → an "unavailable" note; a price but < 2 history
 * points → the price with a "not enough data" caption instead of a broken chart.
 */

import { useMemo, useState } from "react";
import { View, Text, type LayoutChangeEvent } from "react-native";
import Svg, {
  Polyline,
  Path,
  Defs,
  LinearGradient,
  Stop,
  Circle,
} from "react-native-svg";
import { useTheme } from "@oxy.so/bloom/theme";
import { FONT_PHUDU_BLACK } from "../../utils/fonts";
import { formatFiatAmount, t } from "../../i18n";
import type { PriceHistoryPoint } from "../../services/market";

/** Chart height in px; width is measured from the container via onLayout. */
const CHART_HEIGHT = 120;
/** Vertical inset (px) so the stroke and end dot never clip at the edges. */
const CHART_PADDING = 6;

interface PriceSparklineProps {
  /** Price series, oldest→newest. */
  points: PriceHistoryPoint[];
  /** 24h change as a percentage, or null when it can't be derived. */
  changePct: number | null;
  /** Current FAIR/USD unit price, or null when unavailable. */
  currentPriceUsd: number | null;
}

export function PriceSparkline({
  points,
  changePct,
  currentPriceUsd,
}: PriceSparklineProps) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const trendColor =
    changePct == null || changePct === 0
      ? theme.colors.textSecondary
      : changePct > 0
        ? theme.colors.success
        : theme.colors.error;

  const geometry = useMemo(() => {
    if (width <= 0 || points.length < 2) return null;

    const prices = points.map((point) => point.priceUsd);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    const innerHeight = CHART_HEIGHT - CHART_PADDING * 2;
    const stepX = width / (points.length - 1);

    const coords = points.map((point, index) => ({
      x: index * stepX,
      // Center a flat series (range 0) instead of pinning it to the bottom.
      y:
        CHART_PADDING +
        (1 - (range === 0 ? 0.5 : (point.priceUsd - min) / range)) * innerHeight,
    }));

    const line = coords.map((coord) => `${coord.x},${coord.y}`).join(" ");
    const first = coords[0];
    const last = coords[coords.length - 1];
    const area = `M ${first.x},${CHART_HEIGHT} ${coords
      .map((coord) => `L ${coord.x},${coord.y}`)
      .join(" ")} L ${last.x},${CHART_HEIGHT} Z`;

    return { line, area, last };
  }, [width, points]);

  const priceLabel =
    currentPriceUsd != null ? formatFiatAmount(currentPriceUsd, "USD") : null;
  const changeLabel =
    changePct != null
      ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`
      : null;

  const onChartLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  return (
    <View>
      <View className="px-5">
        <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {t("overview.priceChart.title")}
        </Text>

        {priceLabel ? (
          <View className="flex-row items-end mt-1.5">
            <Text
              className="text-foreground"
              style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 40 }}
            >
              {priceLabel}
            </Text>
            {changeLabel ? (
              <Text
                className="text-base font-semibold ml-3 mb-2"
                style={{ color: trendColor }}
              >
                {changeLabel}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text className="text-muted-foreground text-base mt-1.5">
            {t("overview.priceChart.unavailable")}
          </Text>
        )}
      </View>

      <View
        onLayout={onChartLayout}
        style={{ height: CHART_HEIGHT }}
        className="mt-5 justify-center"
      >
        {geometry ? (
          <Svg width={width} height={CHART_HEIGHT}>
            <Defs>
              <LinearGradient id="sparklineFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={trendColor} stopOpacity={0.18} />
                <Stop offset="1" stopColor={trendColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={geometry.area} fill="url(#sparklineFill)" />
            <Polyline
              points={geometry.line}
              fill="none"
              stroke={trendColor}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <Circle
              cx={geometry.last.x}
              cy={geometry.last.y}
              r={4}
              fill={trendColor}
            />
          </Svg>
        ) : priceLabel ? (
          <Text className="text-muted-foreground text-xs px-5">
            {t("overview.priceChart.notEnoughData")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

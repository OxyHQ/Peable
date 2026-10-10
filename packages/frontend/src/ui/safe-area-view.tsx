import {
  SafeAreaView as RawSafeAreaView,
  type SafeAreaViewProps,
} from 'react-native-safe-area-context';
import type { ComponentType } from 'react';
import { styled } from 'nativewind';

/**
 * NativeWind 5 / react-native-css do NOT apply `className` to
 * react-native-safe-area-context's `SafeAreaView` — the global-className
 * polyfill re-exports it raw, with no className→style interop, so
 * `<SafeAreaView className="flex-1 bg-background">` is silently dropped and the
 * screen root renders transparent / collapses to zero height. `styled()` wraps
 * it in the same interop as `react-native-css`'s own `View`, so `className`
 * (layout utilities and `bg-*` alike) applies again. Import `SafeAreaView` from
 * here instead of directly from `react-native-safe-area-context`.
 */
export const SafeAreaView: ComponentType<SafeAreaViewProps & { className?: string }> = styled(
  RawSafeAreaView,
  { className: 'style' },
);

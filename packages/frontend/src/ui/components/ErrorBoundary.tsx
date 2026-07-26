/**
 * Root error boundary.
 *
 * Without one, a throw anywhere in the render tree unmounts the whole app and
 * leaves a black screen — with no message, no way back, and (for a wallet) no
 * indication whether funds are affected. This catches it, records a redacted
 * entry via {@link recordCrash}, and offers a retry that remounts the subtree.
 *
 * Deliberately a class component: `componentDidCatch` / `getDerivedStateFromError`
 * have no hook equivalent.
 */

import { Component, type ReactNode } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { recordCrash } from "../../services/crash-log";
import { t } from "../../i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    void recordCrash(error, false);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Text className="text-foreground text-xl font-semibold text-center">
          {t("crash.title")}
        </Text>
        <Text className="text-muted-foreground text-[15px] text-center mt-2 leading-5">
          {t("crash.subtitle")}
        </Text>

        <ScrollView
          className="max-h-40 self-stretch mt-5 rounded-2xl bg-surface px-4 py-3"
          contentContainerClassName="grow-0"
        >
          <Text className="text-muted-foreground text-xs">
            {error.name}: {error.message}
          </Text>
        </ScrollView>

        <Pressable
          onPress={this.handleRetry}
          accessibilityRole="button"
          className="mt-6 self-stretch rounded-full bg-primary py-3.5 items-center active:opacity-70"
        >
          <Text className="text-primary-foreground text-base font-semibold">
            {t("crash.retry")}
          </Text>
        </Pressable>
      </View>
    );
  }
}

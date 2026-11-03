/**
 * How the shell arranges itself at a window width. Pure, so the breakpoints
 * are tested; `OrbitShell.tsx` hands the answer to Bloom's `AppShell`.
 *
 * - below `SIDEBAR_IN_FLOW_FROM` the sidebar is a DRAWER (always expanded,
 *   opened from the top bar's menu button), as in Nilo
 * - from there to `SIDEBAR_EXPANDED_FROM` it sits in flow as an icon rail: an
 *   expanded 232px panel would leave a tablet's content too narrow for a table
 * - from `SIDEBAR_EXPANDED_FROM` up it is the full panel, unless the person
 *   collapsed it (remembered on the device)
 */

/** From this width up the sidebar sits beside the page; below it, it is a drawer. */
export const SIDEBAR_IN_FLOW_FROM = 768;
/** From this width up the sidebar may be expanded. */
export const SIDEBAR_EXPANDED_FROM = 1024;
/**
 * A detail page's columns (`DetailLayout`): the main column's narrowest and
 * the side panel's width. They sit side by side while the page column (not
 * the window: the sidebar takes its share first) holds both and the gap;
 * below that the panel wraps under the main column. Flexbox decides, so the
 * page never measures itself (and never flashes a one-column first frame).
 */
export const DETAIL_MAIN_MIN_WIDTH = 560;
export const DETAIL_ASIDE_WIDTH = 320;

export type OrbitNavPresentation = 'drawer' | 'rail' | 'panel';

export interface OrbitShellLayout {
  presentation: OrbitNavPresentation;
  /** What the in-flow sidebar is drawn as. A drawer is never collapsed. */
  collapsed: boolean;
  /** The collapse control does nothing here: the width decides. */
  collapseDisabled: boolean;
}

export function shellLayout(width: number, userCollapsed: boolean): OrbitShellLayout {
  if (width < SIDEBAR_IN_FLOW_FROM) {
    return { presentation: 'drawer', collapsed: false, collapseDisabled: true };
  }
  if (width < SIDEBAR_EXPANDED_FROM) {
    return { presentation: 'rail', collapsed: true, collapseDisabled: true };
  }
  return { presentation: 'panel', collapsed: userCollapsed, collapseDisabled: false };
}

/** Phone widths hide the top bar's secondary labels (the search hint, "Test mode"'s caption). */
export const COMPACT_TOP_BAR_BELOW = 640;

export function isCompactTopBar(width: number): boolean {
  return width < COMPACT_TOP_BAR_BELOW;
}

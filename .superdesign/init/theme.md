Bloom blue preset; semantic colors from provider; standard Sidebar, Table and Screen spacing.
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css";
@import "nativewind/theme";
@import "@oxy.so/bloom/design-tokens/theme.css";

@source "./app/**/*.{js,jsx,ts,tsx}";
@source "./src/**/*.{js,jsx,ts,tsx}";
/*
 * Bloom's own components style themselves with classNames, so Tailwind has to
 * scan Bloom for them. In this monorepo `bunfig.toml` sets the HOISTED linker:
 * Bloom lives in the ROOT node_modules and `./node_modules/@oxy.so/bloom` does
 * not exist. The FAIRWallet path this file was forked with matched nothing, no
 * build said so, and every Bloom class was silently missing — the Bloom `Rail`
 * rendered its active item with no pill and an unreadable label.
 */
@source "../../node_modules/@oxy.so/bloom/lib/**/*.{js,jsx}";
/*
 * The SDK's sign-in screens (`OxySignInPanel`, `OxySignUpPanel`, the account
 * picker) lay out with NativeWind classNames too, so Tailwind scans it the same
 * way; without this the account dialog's sign-in renders unstyled on the web.
 */
@source "../../node_modules/@oxy.so/services/lib/**/*.{js,jsx}";

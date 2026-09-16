/**
 * The code a phone scans, drawn only if the host app installed the renderer.
 *
 * `react-native-qrcode-svg` is an OPTIONAL peer, so the import has to be
 * dynamic: a static one fails the Metro build outright for an app that did not
 * install it, while an unresolvable `import()` bundles cleanly and the `catch`
 * handles it at runtime. That is also why nothing in this directory is reachable
 * from the package's root barrel — `tsc` resolves an `import()` specifier even
 * though the call is lazy, so a re-export would drag this peer into the type
 * graph of every server-side consumer of `@peable.to/pay`.
 *
 * When it is absent the handoff screen still works: the `faircoin:` URI is shown
 * as selectable text next to the address either way, because a QR is useless to
 * someone copying the link into a message.
 */

import { useEffect, useState, type ComponentType } from 'react';
import { View } from 'react-native';

interface QrProps {
  value: string;
  size: number;
  color?: string;
  backgroundColor?: string;
}

/**
 * True white behind the code and near-black ink — the ONLY hardcoded colours in
 * this entry, and they are not theme tokens because a QR is not a UI surface.
 * Bloom's `background` is near-black in the dark theme, and a dark-on-dark code
 * does not scan. Same panel `ProfileQRCard` wraps the Peable app's codes in.
 */
const QUIET_ZONE = '#ffffff';
const QR_INK = '#1b1e09';

/**
 * Module-scoped so the resolution is attempted ONCE per process. `undefined`
 * means not yet tried, `null` means tried and absent — without the second state
 * every mount of a handoff screen retries a module that is not installed.
 */
let resolved: ComponentType<QrProps> | null | undefined;

export function PayQrCode({ value, size }: { value: string; size: number }) {
  const [Qr, setQr] = useState<ComponentType<QrProps> | null>(resolved ?? null);

  useEffect(() => {
    if (resolved !== undefined) return;
    let alive = true;
    import('react-native-qrcode-svg')
      .then((module) => {
        resolved = (module.default ?? null) as ComponentType<QrProps> | null;
        if (alive) setQr(resolved);
      })
      .catch(() => {
        resolved = null;
      });
    return () => {
      alive = false;
    };
  }, []);

  if (Qr === null) return null;

  return (
    <View
      style={{
        backgroundColor: QUIET_ZONE,
        borderRadius: 24,
        padding: 20,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Qr value={value} size={size} color={QR_INK} backgroundColor="transparent" />
    </View>
  );
}

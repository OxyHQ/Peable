import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
// `qr-creator` has no `exports` map, only legacy `main` (a browser-global
// script with NO `module.exports` at all — importing the bare specifier
// resolves to `undefined` under Bun's Node-compatible runtime resolution,
// which follows `main`, not the bundler-only `module` field) and `module`
// (a real ES module, which is what Vite's bundler resolves via `module` and
// what makes the browser build work). Importing this exact path sidesteps
// the ambiguity so both Vite and `bun test` resolve the same real export.
import QrCreator from 'qr-creator/dist/qr-creator.es6.min.js';

// `QrCreator.render` is an imperative DOM API — it creates a fresh <canvas>
// and appends it into the given container, so this is a legitimate
// useEffect (syncing with a non-React drawing library), not a code smell.
// The container is cleared first: `render` never removes a canvas it
// previously appended, so a re-render with new `text` would otherwise stack
// canvases.
export function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    // Fixed black-on-white regardless of the app's color scheme: a QR code
    // is a scan target, not themed UI — matching --text/--bg here would make
    // it unscannable in dark mode (light fill on a dark page background).
    QrCreator.render(
      { text, size, radius: 0, ecLevel: 'M', fill: '#000000', background: '#ffffff' },
      container,
    );
  }, [text, size]);

  return <div ref={containerRef} className="qr" role="img" aria-label={t('qrLabel')} />;
}

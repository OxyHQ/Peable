/**
 * SendIcon — a filled paper-plane (from Allo's ChatActive glyph) used for the
 * Send action, mirrored horizontally (`scaleX: -1`) so it points the send way.
 * Drawn with react-native-svg so it inherits the theme colour like a font icon.
 */

import Svg, { Path } from 'react-native-svg';

interface SendIconProps {
  color: string;
  size?: number;
}

export function SendIcon({ color, size = 24 }: SendIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: [{ scaleX: -1 }] }}>
      <Path
        fill={color}
        d="M22.513 3.576C21.826 2.552 20.617 2 19.384 2H4.621c-1.474 0-2.878.818-3.46 2.173-.6 1.398-.297 2.935.784 3.997l3.359 3.295a1 1 0 0 0 1.195.156l8.522-4.849a1 1 0 1 1 .988 1.738l-8.526 4.851a1 1 0 0 0-.477 1.104l1.218 5.038c.343 1.418 1.487 2.534 2.927 2.766.208.034.412.051.616.051 1.26 0 2.401-.644 3.066-1.763l7.796-13.118a3.572 3.572 0 0 0-.116-3.863Z"
      />
    </Svg>
  );
}

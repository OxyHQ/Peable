/**
 * ArrowCircleDownIcon — Material Symbols "arrow_circle_down" (filled), used for
 * the Receive action. Drawn with react-native-svg so it inherits the theme
 * colour like a font icon (`viewBox` is Material Symbols' `0 -960 960 960`).
 */

import Svg, { Path } from 'react-native-svg';

interface ArrowCircleDownIconProps {
  color: string;
  size?: number;
}

export function ArrowCircleDownIcon({ color, size = 24 }: ArrowCircleDownIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 -960 960 960">
      <Path
        fill={color}
        d="M429.5-493.83 399-524q-14.83-14.83-35.08-14.83t-35.59 15.16Q312-508.5 312-488.75t16.32 36.04L444.5-336.83q14.98 15.16 35.44 15.16 20.45 0 35.89-15.16l116.34-116.34Q648-468 648.08-488.33q.09-20.34-16.08-35.67-15.17-15.33-35.42-15.33T561-524l-30.17 30.17V-608.5q0-20.78-14.83-35.64T480-659q-21.17 0-35.83 14.86-14.67 14.86-14.67 35.64v114.67Zm50.54 435.16q-87.61 0-164.44-32.93-76.82-32.93-133.96-90.16Q124.5-239 91.58-315.71q-32.91-76.71-32.91-164.25 0-88.28 32.93-165.11 32.93-76.82 90.16-133.79 57.24-56.97 133.95-90.06Q392.42-902 479.96-902q88.28 0 165.11 33.18 76.83 33.17 133.8 90.16 56.96 56.99 90.05 133.7Q902-568.24 902-480.04q0 87.61-33.1 164.44-33.09 76.82-90.16 133.96-57.07 57.14-133.78 90.06-76.72 32.91-164.92 32.91Z"
      />
    </Svg>
  );
}

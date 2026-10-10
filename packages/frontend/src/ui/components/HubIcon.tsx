/**
 * HubIcon — Material Symbols "hub" (filled), used for the Nodes action. Drawn
 * with react-native-svg so it inherits the theme colour like a font icon
 * (`viewBox` is Material Symbols' `0 -960 960 960`).
 */

import Svg, { Path } from 'react-native-svg';

interface HubIconProps {
  color: string;
  size?: number;
}

export function HubIcon({ color, size = 24 }: HubIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 -960 960 960">
      <Path
        fill={color}
        d="M163-83q-32-32-32-77t32-77q32-32 77-32 9 0 20.5 2.5T283-259l106-131q-15-19-19.5-36.5T365-468l-155-51q-14 22-38.5 35T120-471q-45 0-77-32t-32-77q0-45 32-77t77-32q44 0 76 31t33 75q0 4-.5 5t-.5 2l155 55q10-16 27-29.5t41-21.5v-164q-38-9-59-39t-21-65q0-45 32-77t77-32q45 0 77 32t32 77q0 35-20.5 65T509-736v164q25 8 41 20.5t27 30.5l155-55-1-3v-4q2-44 33.5-75t75.5-31q45 0 77 32t32 77q0 45-32 77t-77 32q-27 0-51-13t-39-35l-156 51q0 24-4 42t-19 35l106 131q11-4 22.5-6.5T720-269q45 0 77 32t32 77q0 45-32 77t-77 32q-45 0-77-32t-32-77q0-17 4-32t17-30L528-355q-19 10-47 10t-48-10L328-222q12 15 16.5 30t4.5 32q0 45-32 77t-77 32q-45 0-77-32Z"
      />
    </Svg>
  );
}

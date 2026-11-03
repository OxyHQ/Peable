import { Platform } from 'react-native';
import { OXY_AUTH_REDIRECT_URI } from '../config';
import { originOf } from '../money/forms';

/** Where a hosted page sends its visitor back to: the origin Orbit runs at. */
export function orbitOrigin(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return originOf(OXY_AUTH_REDIRECT_URI);
}

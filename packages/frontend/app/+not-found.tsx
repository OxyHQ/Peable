/**
 * Custom 404 / unmatched route screen.
 *
 * expo-router automatically renders this file for any URL that doesn't resolve
 * to a real route. The body lives in `src/ui/components/NotFoundScreen` because
 * `app/(tabs)/[username].tsx` renders the same 404 for the non-`@handle` single-segment
 * paths its dynamic segment also matches.
 */

import { NotFoundScreen } from "../src/ui/components/NotFoundScreen";

export default NotFoundScreen;

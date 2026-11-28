/**
 * Pages Advanced Mode (`_routes.json` sends this Worker every request): assets
 * come from the binding, and this Worker owns their cache policy.
 *
 * Everything the Expo export writes under `/_expo/static/` is named by a hash of
 * its bytes (`entry-<32 hex>.js`, `<name>-<32 hex>.css`), so a browser keeps it
 * for a year and never asks again; without this the zone's 4-hour browser TTL
 * made a returning visitor revalidate every one. Entry files (`index.html`,
 * `public/`) are not hashed and keep the asset server's default.
 *
 * The asset server answers a hashed name this deploy does not have (an old tab
 * asking for the last release's chunk) with the `index.html` shell. Under that
 * name it is a 404 that nothing keeps, never HTML a year-long cache would pin.
 */
const HASHED_PREFIX = '/_expo/static/';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (!new URL(request.url).pathname.startsWith(HASHED_PREFIX)) return response;
    if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
      return new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
      });
    }
    if (response.status !== 200 && response.status !== 304) return response;
    const served = new Response(response.body, response);
    served.headers.set('Cache-Control', IMMUTABLE);
    return served;
  },
};

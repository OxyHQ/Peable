import type { WebhookEnabledEvent, WebhookEndpoint } from '@peable.to/shared-types';

/**
 * What Orbit's "Add endpoint" form turns into a `POST /webhook_endpoints`
 * body (ADR 0014 D4). Pure, so the rules a person can get wrong are tested
 * apart from the screen.
 */

export interface EndpointForm {
  url: string;
  /** Event types separated by spaces or commas; `*` is every event. */
  events: string;
  description: string;
}

export const EMPTY_ENDPOINT_FORM: EndpointForm = { url: '', events: '*', description: '' };

/** How long a rolled secret keeps signing beside its replacement: the gateway's maximum. */
export const ROLL_OVERLAP_SECONDS = 24 * 60 * 60;

export type EndpointFormResult =
  | {
      ok: true;
      body: { url: string; enabled_events: WebhookEnabledEvent[]; description?: string };
    }
  | { ok: false; error: 'url' | 'events' };

/**
 * The create body. The URL is checked here only for being one; the gateway
 * applies the delivery SSRF rules (https in live mode, public host, port
 * 443/80) and answers what it refuses.
 */
export function buildEndpointBody(form: EndpointForm): EndpointFormResult {
  const url = form.url.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: 'url' };
  const events = [...new Set(form.events.split(/[\s,]+/).filter((event) => event.length > 0))];
  if (events.length === 0) return { ok: false, error: 'events' };
  const description = form.description.trim();
  return {
    ok: true,
    // The gateway is the judge of which types exist: an unknown one is a 400
    // naming it, not something this form restates the catalog to catch.
    body: {
      url,
      enabled_events: events as WebhookEnabledEvent[],
      ...(description ? { description } : {}),
    },
  };
}

/** `*` reads as "every event"; otherwise the types themselves. */
export function describeEnabledEvents(
  endpoint: Pick<WebhookEndpoint, 'enabled_events'>,
  allLabel: string,
): string {
  return endpoint.enabled_events.includes('*') ? allLabel : endpoint.enabled_events.join(', ');
}

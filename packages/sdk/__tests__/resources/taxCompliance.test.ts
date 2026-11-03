import { describe, expect, it } from 'bun:test';
import type { RestClient, RestClientRequestOptions } from '../../src/core/client';
import { TaxResource } from '../../src/resources/tax';

function recordingClient() {
  const calls: { method: string; path: string; options?: RestClientRequestOptions }[] = [];
  const client = {
    async request(method: string, path: string, options?: RestClientRequestOptions) {
      calls.push({ method, path, options });
      return { object: 'list', data: [], has_more: false, url: path };
    },
  } as unknown as RestClient;
  return { client, calls };
}

describe('tax.compliance', () => {
  it('reads the owner’s records and runs assessments on the merchant API paths', async () => {
    const { client, calls } = recordingClient();
    const { compliance } = new TaxResource(client);
    await compliance.retrieveBusinessProfile();
    await compliance.createAssessment({ as_of: 1_790_000_000 });
    await compliance.replayAssessment('taxasm_1');
    await compliance.listReviewItems({ status: 'open', limit: 5 });
    await compliance.listDeadlines();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/tax/business_profile',
      'POST /v1/tax/assessments',
      'GET /v1/tax/assessments/taxasm_1/replay',
      'GET /v1/tax/review_items',
      'GET /v1/tax/deadlines',
    ]);
    expect(calls[1]?.options?.body).toEqual({ as_of: 1_790_000_000 });
    expect(calls[3]?.options?.query).toMatchObject({ status: 'open', limit: 5 });
  });

  it('offers no way to record an onboarding fact or decide a review item', () => {
    const { client } = recordingClient();
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(new TaxResource(client).compliance),
    );
    for (const forbidden of [
      'updateBusinessProfile',
      'resolveReviewItem',
      'createRegistrationDeclaration',
    ])
      expect(methods).not.toContain(forbidden);
  });
});

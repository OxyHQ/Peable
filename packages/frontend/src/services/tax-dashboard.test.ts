import { expect, it, mock } from 'bun:test';
import { readTaxList } from './tax-list';
const raw = mock(async (_input: unknown) => Response.json({ object: 'list', data: [] }));
const client = { requestAuthenticatedResponse: raw };
it('preserves Peable list envelopes through authenticated raw transport', async () => {
  const url = '/v1/dashboard/applications/merchant/tax/registrations?environment=development';
  raw.mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'row' }] }));
  expect(await readTaxList<{ id: string }>(client, url)).toEqual({
    object: 'list',
    data: [{ id: 'row' }],
  });
  expect(raw).toHaveBeenCalledWith({ method: 'GET', url });
});
it('rejects error responses and malformed envelopes instead of rendering an empty list', async () => {
  raw.mockResolvedValueOnce(Response.json({ error: 'forbidden' }, { status: 403 }));
  await expect(readTaxList(client, '/codes')).rejects.toThrow('HTTP 403');
  raw.mockResolvedValueOnce(Response.json({ data: [] }));
  await expect(readTaxList(client, '/codes')).rejects.toThrow('Invalid Peable tax list response');
});

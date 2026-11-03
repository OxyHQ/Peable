import { Peable } from '@peable.to/sdk';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

// An Oxy application credential of a TEST environment: its environment, not
// anything sent here, is what makes every call below test mode. Server only —
// the browser never sees the secret.
export const peable = new Peable({
  publicKey: required('PEABLE_PUBLIC_KEY'),
  secret: required('PEABLE_SECRET'),
  baseURL: process.env.PEABLE_API_URL,
});

// The endpoint's `whsec_…`, or the one `peable listen` prints for its session.
export const webhookSecret = required('PEABLE_WEBHOOK_SECRET');

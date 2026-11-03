import { Peable } from '@peable.to/sdk';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

// Verifying a signature makes no request; the credential is for the handlers,
// which re-read the objects an event names. A TEST-environment credential.
export const peable = new Peable({
  publicKey: required('PEABLE_PUBLIC_KEY'),
  secret: required('PEABLE_SECRET'),
  baseURL: process.env.PEABLE_API_URL,
});

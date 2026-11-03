import { OxyServices } from '@oxy.so/core';
export const OXY_BASE_URL = process.env.EXPO_PUBLIC_OXY_BASE_URL ?? 'https://api.oxy.so';
export const GATEWAY_API_URL = process.env.EXPO_PUBLIC_GATEWAY_API_URL ?? 'https://api.peable.to';
// Public Oxy client configuration; authority still comes from the signed-in user's membership.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_857cabdaba3f79ec5c931706424f439b67f3bc7b7bc34fca';
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ?? 'https://peable.to';
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
export const gateway = oxyServices.createLinkedClient({ baseURL: GATEWAY_API_URL });

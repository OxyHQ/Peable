import { describe, expect, it } from 'bun:test';
import { OrbitApiError } from '../api/transport';
import {
  buildFaircoinKeyBody,
  emptyFaircoinKeyForm,
  faircoinKeyFormErrorKey,
  faircoinKeyRefusalKey,
  faircoinKeyStatus,
  networksFor,
} from './faircoinKey';
import { t } from '../i18n';

const refusal = (code: string, param?: string) =>
  new OrbitApiError({
    status: code === 'watch_only_violation' || code === 'parameter_invalid' ? 400 : 409,
    type: 'invalid_request_error',
    code,
    message: 'x',
    ...(param ? { param } : {}),
  });

describe('faircoinKeyStatus', () => {
  it('is required in both modes, and blocking only in live', () => {
    expect(faircoinKeyStatus({ xpub: null, environment: 'production' })).toBe('required_live');
    expect(faircoinKeyStatus({ xpub: null, environment: 'development' })).toBe('required_test');
    expect(faircoinKeyStatus({ xpub: 'xpub6', environment: 'production' })).toBe('registered');
  });
});

describe('the key form', () => {
  it('offers testnet only outside production, both in live', () => {
    expect(networksFor('development')).toEqual(['testnet']);
    expect(networksFor('production')).toEqual(['mainnet', 'testnet']);
    expect(emptyFaircoinKeyForm('development')).toEqual({ network: 'testnet', xpub: '' });
    expect(emptyFaircoinKeyForm('production')).toEqual({ network: 'mainnet', xpub: '' });
  });

  it('sends the trimmed key and its network', () => {
    expect(buildFaircoinKeyBody({ network: 'testnet', xpub: ' tpubD6 ' }, 'development')).toEqual({
      ok: true,
      body: { network: 'testnet', xpub: 'tpubD6' },
    });
  });

  it('refuses an empty key, a private key and a network this mode cannot register', () => {
    expect(buildFaircoinKeyBody({ network: 'testnet', xpub: '  ' }, 'development')).toEqual({
      ok: false,
      error: 'xpub_missing',
    });
    for (const xpub of ['xprv9s21', 'tprv8Z', 'zprvAW']) {
      expect(buildFaircoinKeyBody({ network: 'mainnet', xpub }, 'production')).toEqual({
        ok: false,
        error: 'private_key',
      });
    }
    expect(buildFaircoinKeyBody({ network: 'mainnet', xpub: 'xpub6' }, 'development')).toEqual({
      ok: false,
      error: 'network',
    });
  });

  it('words every form error', () => {
    for (const error of ['xpub_missing', 'private_key', 'network'] as const) {
      const key = faircoinKeyFormErrorKey(error);
      expect(t(key)).not.toBe(key);
    }
  });
});

describe('faircoinKeyRefusalKey', () => {
  it('words each refusal of the registration', () => {
    for (const error of [
      refusal('already_registered'),
      refusal('key_in_use'),
      refusal('watch_only_violation'),
      refusal('parameter_invalid', 'network'),
    ]) {
      const key = faircoinKeyRefusalKey(error);
      expect(key).not.toBeNull();
      expect(t(key ?? '')).not.toBe(key);
    }
  });

  it('leaves anything else to the gateway’s own message', () => {
    expect(faircoinKeyRefusalKey(refusal('parameter_invalid', 'xpub'))).toBeNull();
    expect(faircoinKeyRefusalKey(refusal('resource_missing'))).toBeNull();
    expect(faircoinKeyRefusalKey(new Error('offline'))).toBeNull();
  });
});

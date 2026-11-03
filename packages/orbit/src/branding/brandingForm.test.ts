import { describe, expect, it } from 'bun:test';
import {
  BRANDING_BORDER_STYLES,
  BRANDING_COLOR_PATTERN,
  BRANDING_FONTS,
  DEFAULT_BRANDING,
  type MerchantBranding,
  type MerchantEmailSettings,
} from '@peable.to/shared-types';
import {
  brandingFormOf,
  brandingPreview,
  buildBrandingPatch,
  buildEmailSettingsPatch,
  emailSettingsFormOf,
  normalizeColor,
  ORBIT_BORDER_STYLES,
  ORBIT_BRANDING_COLOR,
  ORBIT_BRANDING_FONTS,
  ORBIT_DEFAULT_BRANDING,
  PREVIEW_FONT_STACKS,
  PREVIEW_RADII,
  readableOn,
} from './brandingForm';

const stored: MerchantBranding = {
  object: 'branding_settings',
  livemode: false,
  use_avatar_as_icon: true,
  logo: null,
  primary_color: null,
  accent_color: '#112233',
  font: null,
  border_style: 'pill',
  terms_of_service_url: null,
  updated_at: 1,
};

describe('restated values', () => {
  it('are the shared-types originals', () => {
    expect([...ORBIT_BRANDING_FONTS]).toEqual([...BRANDING_FONTS]);
    expect([...ORBIT_BORDER_STYLES]).toEqual([...BRANDING_BORDER_STYLES]);
    expect(ORBIT_BRANDING_COLOR.source).toBe(BRANDING_COLOR_PATTERN.source);
    expect(ORBIT_DEFAULT_BRANDING).toEqual({ ...DEFAULT_BRANDING });
    expect(Object.keys(PREVIEW_FONT_STACKS)).toEqual([...BRANDING_FONTS]);
    expect(Object.keys(PREVIEW_RADII)).toEqual([...BRANDING_BORDER_STYLES]);
  });
});

describe('normalizeColor', () => {
  it('stores lowercase #rrggbb and expands the short form', () => {
    expect(normalizeColor(' #AbCdEf ')).toBe('#abcdef');
    expect(normalizeColor('ABC')).toBe('#aabbcc');
    expect(normalizeColor('')).toBeNull();
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor('#12345')).toBeUndefined();
    expect(normalizeColor('url(x)')).toBeUndefined();
  });
});

describe('buildBrandingPatch', () => {
  it('sends only what changed', () => {
    const form = { ...brandingFormOf(stored), primaryColor: '#FF0000', font: 'serif' as const };
    expect(buildBrandingPatch(stored, form)).toEqual({
      ok: true,
      body: { primary_color: '#ff0000', font: 'serif' },
    });
    expect(buildBrandingPatch(stored, brandingFormOf(stored))).toEqual({ ok: true, body: {} });
  });

  it('clears to the default with null', () => {
    const form = {
      ...brandingFormOf(stored),
      accentColor: '',
      borderStyle: null,
      useAvatarAsIcon: false,
      logo: 'file_1',
      termsOfServiceUrl: ' https://shop.example/terms ',
    };
    expect(buildBrandingPatch(stored, form)).toEqual({
      ok: true,
      body: {
        use_avatar_as_icon: false,
        logo: 'file_1',
        accent_color: null,
        border_style: null,
        terms_of_service_url: 'https://shop.example/terms',
      },
    });
  });

  it('names every field it refuses', () => {
    expect(
      buildBrandingPatch(stored, {
        ...brandingFormOf(stored),
        primaryColor: 'blue',
        accentColor: '#zzzzzz',
        logo: 'a b',
        termsOfServiceUrl: 'http://shop.example/terms',
      }),
    ).toEqual({
      ok: false,
      errors: ['primary_color', 'accent_color', 'logo', 'terms_of_service_url'],
    });
  });
});

describe('brandingPreview', () => {
  it('draws defaults where nothing valid is set', () => {
    const preview = brandingPreview({ ...brandingFormOf(stored), primaryColor: 'nope' });
    expect(preview).toEqual({
      primaryColor: '#1f6feb',
      accentColor: '#112233',
      onPrimary: '#ffffff',
      fontFamily: PREVIEW_FONT_STACKS.system,
      radius: 999,
      showIcon: true,
      showLogo: false,
    });
  });

  it('picks the readable text colour', () => {
    expect(readableOn('#ffffff')).toBe('#000000');
    expect(readableOn('#ffeb3b')).toBe('#000000');
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#0b1f33')).toBe('#ffffff');
  });
});

describe('email settings', () => {
  const settings: MerchantEmailSettings = {
    object: 'email_settings',
    livemode: true,
    payment_receipts: true,
    refund_notices: true,
    checkout_confirmations: false,
    support_email: null,
    updated_at: null,
  };

  it('patches what changed', () => {
    expect(
      buildEmailSettingsPatch(settings, {
        ...emailSettingsFormOf(settings),
        refundNotices: false,
        supportEmail: ' help@shop.example ',
      }),
    ).toEqual({ refund_notices: false, support_email: 'help@shop.example' });
    expect(buildEmailSettingsPatch(settings, emailSettingsFormOf(settings))).toEqual({});
  });

  it('refuses a support email that is not an address', () => {
    expect(
      buildEmailSettingsPatch(settings, { ...emailSettingsFormOf(settings), supportEmail: 'help' }),
    ).toBeNull();
  });
});

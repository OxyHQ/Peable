import { describe, expect, test } from 'bun:test';
import type { CheckoutBranding } from '@peable.to/shared-types';
import {
  appearanceFromBranding,
  BORDER_RADII,
  FONT_STACKS,
  resolveAppearance,
  toCssVariables,
  toProviderAppearance,
} from '../../src/browser/appearance';

const branding: CheckoutBranding = {
  icon_url: null,
  logo_url: null,
  primary_color: '#ff0066',
  accent_color: '#112233',
  font: 'serif',
  border_style: 'pill',
};

describe('resolveAppearance', () => {
  test('defaults to the peable theme with every variable filled', () => {
    const resolved = resolveAppearance(undefined);
    expect(resolved.theme).toBe('peable');
    expect(resolved.variables.colorPrimary).toBe('#1f6feb');
    expect(Object.keys(resolved.variables).sort()).toEqual(
      [
        'borderRadius',
        'colorBackground',
        'colorDanger',
        'colorPrimary',
        'colorText',
        'fontFamily',
        'spacingUnit',
      ].sort(),
    );
    expect(resolved.rules).toEqual({});
  });

  test('each theme has its own base, and an unknown theme falls back to peable', () => {
    expect(resolveAppearance({ theme: 'night' }).variables.colorBackground).toBe('#0d1117');
    expect(resolveAppearance({ theme: 'flat' }).variables.borderRadius).toBe('4px');
    expect(resolveAppearance({ theme: 'neon' as unknown as 'flat' }).theme).toBe('peable');
  });

  test('valid variables override the theme; invalid ones are dropped, never passed on', () => {
    const resolved = resolveAppearance({
      variables: {
        colorPrimary: '#abc',
        colorText: 'red; background:url(https://evil.example/x)',
        colorDanger: 'javascript:alert(1)',
        borderRadius: '12px',
        spacingUnit: 'calc(100vw)',
        fontFamily: 'Arial; } body { display:none',
      },
    });
    expect(resolved.variables.colorPrimary).toBe('#abc');
    expect(resolved.variables.borderRadius).toBe('12px');
    expect(resolved.variables.colorText).toBe('#0b1f33');
    expect(resolved.variables.colorDanger).toBe('#c62828');
    expect(resolved.variables.spacingUnit).toBe('4px');
    expect(resolved.variables.fontFamily).toBe(FONT_STACKS.system);
  });

  test('rules keep only known selectors, known properties and safe values', () => {
    const resolved = resolveAppearance({
      rules: {
        '.Input': {
          color: '#123456',
          backgroundImage: 'url(https://evil.example/track.png)',
          border: '1px solid #ccc',
          boxShadow: 'url(https://evil.example)',
        },
        '.Input:focus': { borderColor: 'expression(alert(1))' },
        body: { color: 'red' },
        '.Label': { fontWeight: '600' },
      },
    });
    expect(resolved.rules).toEqual({
      '.Input': { color: '#123456', border: '1px solid #ccc' },
      '.Label': { fontWeight: '600' },
    });
  });
});

describe('toProviderAppearance', () => {
  test("maps 'peable' to the provider's base theme and passes the resolved variables", () => {
    const provider = toProviderAppearance({ variables: { colorPrimary: '#ff0066' } });
    expect(provider.theme).toBe('stripe');
    expect((provider.variables as Record<string, string>).colorPrimary).toBe('#ff0066');
    expect(provider.rules).toBeUndefined();
  });

  test('night and flat keep their names; rules are passed when present', () => {
    expect(toProviderAppearance({ theme: 'night' }).theme).toBe('night');
    const flat = toProviderAppearance({ theme: 'flat', rules: { '.Tab': { color: '#000000' } } });
    expect(flat.theme).toBe('flat');
    expect(flat.rules).toEqual({ '.Tab': { color: '#000000' } });
  });
});

describe('toCssVariables', () => {
  test('names every chrome variable', () => {
    const css = toCssVariables({ variables: { colorPrimary: '#00ff00' } });
    expect(css['--peable-color-primary']).toBe('#00ff00');
    expect(css['--peable-border-radius']).toBe('8px');
    expect(Object.keys(css)).toHaveLength(7);
  });
});

describe('appearanceFromBranding', () => {
  test("a merchant's colour, font and border style become the appearance", () => {
    const appearance = appearanceFromBranding(branding);
    expect(appearance.theme).toBe('peable');
    expect(appearance.variables).toEqual({
      colorPrimary: '#ff0066',
      fontFamily: FONT_STACKS.serif,
      borderRadius: BORDER_RADII.pill,
    });
    expect(resolveAppearance(appearance).variables.borderRadius).toBe('999px');
  });

  test("an integrator's override wins variable by variable", () => {
    const appearance = appearanceFromBranding(branding, {
      theme: 'night',
      variables: { colorPrimary: '#000000' },
      rules: { '.Input': { color: '#ffffff' } },
    });
    expect(appearance.theme).toBe('night');
    expect(appearance.variables?.colorPrimary).toBe('#000000');
    expect(appearance.variables?.fontFamily).toBe(FONT_STACKS.serif);
    expect(appearance.rules).toEqual({ '.Input': { color: '#ffffff' } });
  });
});

describe('rule functions', () => {
  test('colour functions and calc are allowed, any other call is not', () => {
    const resolved = resolveAppearance({
      rules: {
        '.Input': { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)', padding: 'calc(4px)' },
        '.Tab': { color: 'image-set("x" 1x)' },
      },
    });
    expect(resolved.rules).toEqual({
      '.Input': { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)', padding: 'calc(4px)' },
    });
  });
});

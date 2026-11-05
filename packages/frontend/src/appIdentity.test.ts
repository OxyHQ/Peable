import { afterEach, expect, test } from 'bun:test';
import appJson from '../app.json';

type ExpoConfig = {
  name?: string;
  ios?: { bundleIdentifier?: string };
  android?: { package?: string };
};

const buildConfig = require('../app.config.js') as (context: { config: ExpoConfig }) => ExpoConfig;
const previousVariant = process.env.APP_VARIANT;

afterEach(() => {
  if (previousVariant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = previousVariant;
});

function resolveConfig(variant?: string): ExpoConfig {
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  return buildConfig({ config: structuredClone(appJson.expo) as ExpoConfig });
}

test('production is to.peable.app on both platforms', () => {
  const expo = resolveConfig();
  expect(expo.android?.package).toBe('to.peable.app');
  expect(expo.ios?.bundleIdentifier).toBe('to.peable.app');
});

test('APP_VARIANT=development is to.peable.app.dev with its own name', () => {
  const prod = resolveConfig();
  const dev = resolveConfig('development');
  expect(dev.android?.package).toBe('to.peable.app.dev');
  expect(dev.ios?.bundleIdentifier).toBe('to.peable.app.dev');
  expect(dev.name).not.toBe(prod.name);
});

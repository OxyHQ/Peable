import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  configPath,
  ConfigError,
  readConfig,
  withCredential,
  withoutCredential,
  writeConfig,
} from '../src/config.js';
import { tempHome } from './support.js';

let home = '';
let cleanup: () => Promise<void> = async () => undefined;

beforeEach(async () => {
  ({ home, cleanup } = await tempHome());
});
afterEach(() => cleanup());

const credential = { public_key: 'oxy_dk_1', secret: 's3cret', merchant: 'merch_1' };

describe('the config file', () => {
  test('lives under XDG_CONFIG_HOME, or ~/.config', () => {
    expect(configPath({ HOME: '/home/a' })).toBe('/home/a/.config/peable/config.json');
    expect(configPath({ HOME: '/home/a', XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/xdg/peable/config.json',
    );
  });

  test.skipIf(process.platform === 'win32')(
    'is written 0600 in a 0700 directory, with no temporary file left behind',
    async () => {
      const path = configPath({ HOME: home });
      await writeConfig(
        path,
        withCredential({ version: 1, profiles: {} }, 'default', 'test', credential),
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect(await readdir(dirname(path))).toEqual(['config.json']);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: 1,
        profiles: { default: { test: credential } },
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'tightens a directory and file that were too open, and warns while they are',
    async () => {
      const path = configPath({ HOME: home });
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, JSON.stringify({ version: 1, profiles: {} }), { mode: 0o644 });
      await chmod(path, 0o644);
      const warnings: string[] = [];
      await readConfig(path, (message) => warnings.push(message));
      expect(warnings.join('')).toContain('readable by other users');
      await writeConfig(path, { version: 1, profiles: {} });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    },
  );

  test('a missing file is an empty config; a foreign one is refused', async () => {
    const path = configPath({ HOME: home });
    expect(await readConfig(path)).toEqual({ version: 1, profiles: {} });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"profiles":[]}', { mode: 0o600 });
    await expect(readConfig(path)).rejects.toBeInstanceOf(ConfigError);
  });

  test('one credential per mode per profile; removing one keeps the other', () => {
    const both = withCredential(
      withCredential({ version: 1, profiles: {} }, 'shop', 'test', credential, {
        base_url: 'http://localhost:3000',
      }),
      'shop',
      'live',
      { ...credential, public_key: 'oxy_dk_live' },
    );
    expect(both.profiles.shop).toMatchObject({
      base_url: 'http://localhost:3000',
      test: credential,
      live: { public_key: 'oxy_dk_live' },
    });
    const liveOnly = withoutCredential(both, 'shop', 'test');
    expect(liveOnly.profiles.shop).toEqual({
      base_url: 'http://localhost:3000',
      live: { ...credential, public_key: 'oxy_dk_live' },
    });
    expect(withoutCredential(liveOnly, 'shop', 'live').profiles).toEqual({});
    expect(withoutCredential(both, 'shop').profiles).toEqual({});
  });
});

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Where `peable login` keeps credentials: `$XDG_CONFIG_HOME/peable/config.json`
 * (`~/.config/peable/config.json` by default), mode 0600 in a 0700 directory.
 *
 * Per PROFILE, up to one Oxy application credential per MODE. The mode is
 * decided by the credential's own environment at the gateway (ADR 0017:
 * `production` is live, every other environment is test) — `--test` / `--live`
 * only chooses which stored credential a command uses, and `login` verifies the
 * two agree before storing anything.
 *
 * The secret is written to this file and nowhere else: never printed, never
 * logged, never put in an error message.
 */

export type Mode = 'test' | 'live';

export interface StoredCredential {
  /** ApplicationCredential publicKey (`oxy_dk_…`). Not a secret. */
  readonly public_key: string;
  /** ApplicationCredential secret. Never printed. */
  readonly secret: string;
  /** The merchant (`merch_…`) the credential resolved to when it was stored. */
  readonly merchant: string;
}

export interface Profile {
  /** Gateway base URL, when not `https://api.peable.to`. */
  readonly base_url?: string;
  /** oxy-api URL the service token is minted at, when not `https://api.oxy.so`. */
  readonly oxy_api_url?: string;
  readonly test?: StoredCredential;
  readonly live?: StoredCredential;
}

export interface ConfigFile {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export const DEFAULT_PROFILE = 'default';
const EMPTY: ConfigFile = { version: 1, profiles: {} };
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

/** The config file's path for this environment. */
export function configPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : undefined);
  if (!base) throw new Error('cannot locate a config directory: set HOME or XDG_CONFIG_HOME');
  return join(base, 'peable', 'config.json');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCredential(value: unknown): StoredCredential | undefined {
  if (!isRecord(value)) return undefined;
  const { public_key, secret, merchant } = value;
  if (typeof public_key !== 'string' || typeof secret !== 'string') return undefined;
  return { public_key, secret, merchant: typeof merchant === 'string' ? merchant : '' };
}

function parseConfig(text: string, path: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON; fix it or remove it and log in again`);
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.profiles)) {
    throw new ConfigError(`${path} is not a Peable CLI config (version 1)`);
  }
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value) || !isValidProfileName(name)) continue;
    const test = parseCredential(value.test);
    const live = parseCredential(value.live);
    profiles[name] = {
      ...(typeof value.base_url === 'string' ? { base_url: value.base_url } : {}),
      ...(typeof value.oxy_api_url === 'string' ? { oxy_api_url: value.oxy_api_url } : {}),
      ...(test ? { test } : {}),
      ...(live ? { live } : {}),
    };
  }
  return { version: 1, profiles };
}

/**
 * Read the config. A missing file is an empty config. A file other users can
 * read is reported through `warn` (and tightened on the next write), because it
 * holds secrets.
 */
export async function readConfig(
  path: string,
  warn: (message: string) => void = () => undefined,
): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
  if (process.platform !== 'win32') {
    const { mode } = await stat(path);
    if ((mode & 0o077) !== 0) {
      warn(
        `${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); run \`chmod 600 ${path}\``,
      );
    }
  }
  return parseConfig(text, path);
}

/**
 * Write the config atomically: a 0600 temporary file beside it, then a rename,
 * so a crash never leaves a half-written file and the secret is never on disk
 * with wider permissions, even for a moment.
 */
export async function writeConfig(path: string, config: ConfigFile): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const temporary = join(directory, `.config.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

/** The config with `credential` stored as `profile`'s `mode` credential. */
export function withCredential(
  config: ConfigFile,
  profile: string,
  mode: Mode,
  credential: StoredCredential,
  urls: { base_url?: string | undefined; oxy_api_url?: string | undefined } = {},
): ConfigFile {
  const existing = config.profiles[profile] ?? {};
  const next: Profile = {
    ...existing,
    ...(urls.base_url !== undefined ? { base_url: urls.base_url } : {}),
    ...(urls.oxy_api_url !== undefined ? { oxy_api_url: urls.oxy_api_url } : {}),
    [mode]: credential,
  };
  return { version: 1, profiles: { ...config.profiles, [profile]: next } };
}

/**
 * The config without `profile` — or, with `mode`, without only that mode's
 * credential (the profile goes when it holds no credential any more).
 */
export function withoutCredential(config: ConfigFile, profile: string, mode?: Mode): ConfigFile {
  const profiles = { ...config.profiles };
  const existing = profiles[profile];
  if (!existing) return config;
  if (mode === undefined) {
    delete profiles[profile];
  } else {
    const other: Mode = mode === 'test' ? 'live' : 'test';
    const kept = existing[other];
    if (kept) {
      profiles[profile] = {
        ...(existing.base_url !== undefined ? { base_url: existing.base_url } : {}),
        ...(existing.oxy_api_url !== undefined ? { oxy_api_url: existing.oxy_api_url } : {}),
        [other]: kept,
      };
    } else {
      delete profiles[profile];
    }
  }
  return { version: 1, profiles };
}

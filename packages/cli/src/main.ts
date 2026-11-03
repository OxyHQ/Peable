import { parseArgs, type ParseArgsConfig } from 'node:util';
import { Peable, PeableError } from '@peable.to/sdk';
import {
  REQUEST_LOG_METHODS,
  type CurrencyCode,
  type Merchant,
  type NetworkType,
  type PaymentIntentRail,
  type PaymentIntentStatus,
  type RequestLogMethod,
  type RequestLogStatusFilter,
  type WebhookEnabledEvent,
} from '@peable.to/shared-types';
import {
  configPath,
  DEFAULT_PROFILE,
  isValidProfileName,
  readConfig,
  writeConfig,
  withCredential,
  withoutCredential,
  type Mode,
} from './config.js';
import {
  FIXTURES,
  FixtureUnavailableError,
  isTriggerable,
  TRIGGERABLE_EVENTS,
} from './fixtures.js';
import type { Io } from './io.js';
import { render } from './output.js';
import { runListen, runLogsTail } from './tail.js';
import { CLI_VERSION } from './version.js';

/**
 * The `peable` command line. `main` parses, dispatches and answers an exit
 * code: 0 success, 1 a failed operation (the API refused, the network failed),
 * 2 a usage error.
 */

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | string[] | undefined>;

interface Context {
  readonly io: Io;
  readonly values: Values;
  readonly positionals: readonly string[];
  readonly profile: string;
  readonly mode: Mode;
  readonly json: boolean;
  /** The SDK client for the selected profile and mode. Throws `UsageError` when not logged in. */
  peable(): Promise<Peable>;
}

interface Command {
  readonly usage: string;
  readonly summary: string;
  readonly options?: Options;
  /** How many positionals it takes (after the command words). */
  readonly positionals?: number;
  run(context: Context): Promise<void>;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const GLOBAL_OPTIONS: Options = {
  profile: { type: 'string' },
  live: { type: 'boolean' },
  test: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const LIST_OPTIONS: Options = {
  limit: { type: 'string' },
  'starting-after': { type: 'string' },
  'ending-before': { type: 'string' },
};

const PAYMENT_OPTIONS: Options = {
  amount: { type: 'string' },
  currency: { type: 'string' },
  rail: { type: 'string' },
  network: { type: 'string' },
  metadata: { type: 'string', multiple: true },
};

function str(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

function required(values: Values, name: string): string {
  const value = str(values, name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

function listParams(values: Values) {
  const limit = str(values, 'limit');
  if (limit !== undefined && !/^\d+$/.test(limit)) throw new UsageError('--limit is a number');
  return {
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(str(values, 'starting-after') ? { starting_after: str(values, 'starting-after') } : {}),
    ...(str(values, 'ending-before') ? { ending_before: str(values, 'ending-before') } : {}),
  };
}

/** `--metadata key=value`, repeatable. */
function metadata(values: Values): Record<string, string> | undefined {
  const entries = values.metadata;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new UsageError(`--metadata takes key=value, not '${entry}'`);
    out[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return out;
}

function paymentParams(values: Values) {
  const amount = required(values, 'amount');
  const network = str(values, 'network');
  const rail = str(values, 'rail');
  const meta = metadata(values);
  return {
    amount,
    ...(rail ? { rail: rail as PaymentIntentRail } : {}),
    ...(str(values, 'currency') ? { currency: str(values, 'currency') as CurrencyCode } : {}),
    // FairCoin is the default rail, and a test-mode merchant is on testnet.
    ...(network
      ? { network: network as NetworkType }
      : rail === undefined || rail === 'faircoin'
        ? { network: 'testnet' as NetworkType }
        : {}),
    ...(meta ? { metadata: meta } : {}),
  };
}

function testModeOnly(context: Context, what: string): void {
  if (context.mode === 'live') {
    throw new UsageError(`${what} is test mode only; drop --live`);
  }
}

function parseStatusFilter(value: string | undefined): RequestLogStatusFilter | undefined {
  if (value === undefined) return undefined;
  if (/^[2-5]xx$/.test(value)) return value as RequestLogStatusFilter;
  if (/^[1-5]\d\d$/.test(value)) return Number(value);
  throw new UsageError('--status is a code (404) or a class (2xx, 4xx, 5xx)');
}

function parseMethod(value: string | undefined): RequestLogMethod | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  if (!(REQUEST_LOG_METHODS as readonly string[]).includes(upper)) {
    throw new UsageError(`--method is one of ${REQUEST_LOG_METHODS.join(', ')}`);
  }
  return upper as RequestLogMethod;
}

function describeMerchant(merchant: Merchant): string {
  const name = merchant.display_name ? ` (${merchant.display_name})` : '';
  return `${merchant.id}${name} — ${merchant.livemode ? 'live' : 'test'} mode, ${merchant.network ?? 'no FairCoin'}`;
}

const COMMANDS: Record<string, Command> = {
  login: {
    usage:
      'peable login [--profile <name>] [--test|--live] [--public-key <oxy_dk_…>] [--base-url <url>] [--oxy-api-url <url>]',
    summary: 'Store an Oxy application credential for a profile and mode',
    options: {
      'public-key': { type: 'string' },
      'base-url': { type: 'string' },
      'oxy-api-url': { type: 'string' },
    },
    async run(context) {
      const { io, values } = context;
      const publicKey =
        str(values, 'public-key') ?? (await io.prompt('Application credential public key: '));
      if (!publicKey) throw new UsageError('a public key is required');
      const secret = await io.readSecret('Application credential secret (hidden): ');
      if (!secret) throw new UsageError('a secret is required');
      const path = configPath(io.env);
      const config = await readConfig(path, io.err);
      const existing = config.profiles[context.profile];
      const baseURL = str(values, 'base-url') ?? existing?.base_url;
      const oxyApiUrl = str(values, 'oxy-api-url') ?? existing?.oxy_api_url;

      // Verified before anything is stored: the credential works, and the mode
      // its environment selects (ADR 0017) is the mode it is stored under.
      const peable = new Peable({
        publicKey,
        secret,
        ...(baseURL ? { baseURL } : {}),
        ...(oxyApiUrl ? { oxyApiUrl } : {}),
      });
      const merchant = await peable.merchants.retrieve();
      const actual: Mode = merchant.livemode ? 'live' : 'test';
      if (actual !== context.mode) {
        throw new UsageError(
          `this is a ${actual}-mode credential (its environment is ${merchant.environment}); log in with --${actual}`,
        );
      }
      await writeConfig(
        path,
        withCredential(
          config,
          context.profile,
          context.mode,
          { public_key: publicKey, secret, merchant: merchant.id },
          { base_url: str(values, 'base-url'), oxy_api_url: str(values, 'oxy-api-url') },
        ),
      );
      io.out(`Logged in to ${describeMerchant(merchant)} as profile '${context.profile}'.`);
      io.out(`Credentials saved to ${path}`);
    },
  },

  logout: {
    usage: 'peable logout [--profile <name>] [--test|--live] [--all]',
    summary: "Remove a profile's stored credentials (both modes unless --test/--live)",
    options: { all: { type: 'boolean' } },
    async run(context) {
      const { io, values } = context;
      const path = configPath(io.env);
      const config = await readConfig(path, io.err);
      if (values.all === true) {
        await writeConfig(path, { version: 1, profiles: {} });
        io.out('Removed every profile.');
        return;
      }
      if (!config.profiles[context.profile]) {
        io.out(`Profile '${context.profile}' holds no credentials.`);
        return;
      }
      const explicitMode = values.live === true || values.test === true;
      await writeConfig(
        path,
        withoutCredential(config, context.profile, explicitMode ? context.mode : undefined),
      );
      io.out(
        explicitMode
          ? `Removed the ${context.mode}-mode credential of profile '${context.profile}'.`
          : `Removed profile '${context.profile}'.`,
      );
    },
  },

  whoami: {
    usage: 'peable whoami [--profile <name>] [--test|--live] [--json]',
    summary: 'Show the merchant the stored credential resolves to',
    async run(context) {
      const merchant = await (await context.peable()).merchants.retrieve();
      if (context.json) {
        context.io.out(JSON.stringify(merchant, null, 2));
        return;
      }
      context.io.out(`${describeMerchant(merchant)} — profile '${context.profile}'`);
    },
  },

  listen: {
    usage:
      'peable listen [--forward-to <url>] [--events <type,prefix.*>] [--print-json] [--profile <name>]',
    summary: 'Stream test-mode events, signed with a session secret, to a local endpoint',
    options: {
      'forward-to': { type: 'string' },
      events: { type: 'string' },
      'print-json': { type: 'boolean' },
    },
    async run(context) {
      testModeOnly(context, 'peable listen');
      const forwardTo = str(context.values, 'forward-to');
      if (forwardTo !== undefined) {
        let url: URL;
        try {
          url = new URL(forwardTo);
        } catch {
          throw new UsageError(`--forward-to is not a URL: ${forwardTo}`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new UsageError('--forward-to must be an http(s) URL');
        }
      }
      const events = str(context.values, 'events')
        ?.split(',')
        .map((type) => type.trim())
        .filter((type) => type !== '');
      await runListen({
        peable: await context.peable(),
        io: context.io,
        forwardTo,
        events,
        printJson: context.values['print-json'] === true,
        signal: context.io.interrupt,
      });
    },
  },

  trigger: {
    usage: 'peable trigger <event> [--profile <name>]',
    summary: 'Create test-mode objects through the API that cause <event>',
    positionals: 1,
    async run(context) {
      testModeOnly(context, 'peable trigger');
      const event = context.positionals[0];
      if (event === undefined || !isTriggerable(event)) {
        const lines = TRIGGERABLE_EVENTS.map(
          (name) => `  ${name.padEnd(32)} ${FIXTURES[name].description}`,
        );
        const head = event === undefined ? 'Which event?' : `'${event}' cannot be triggered.`;
        throw new UsageError(`${head} Supported events:\n${lines.join('\n')}`);
      }
      const fixture = FIXTURES[event];
      context.io.err(`Setting up fixture for: ${event}`);
      await fixture.run({
        peable: await context.peable(),
        log: (line) => context.io.err(`  ${line}`),
      });
      context.io.out(`Trigger succeeded! Recorded: ${fixture.causes.join(', ')}`);
    },
  },

  'events list': {
    usage: 'peable events list [--type <type|prefix.*>] [--limit <n>] [--json]',
    summary: 'List events of the last 30 days',
    options: { ...LIST_OPTIONS, type: { type: 'string' } },
    async run(context) {
      const type = str(context.values, 'type');
      const page = await (await context.peable()).events.list({
        ...listParams(context.values),
        ...(type ? { type: type as `${string}.*` } : {}),
      });
      context.io.out(render(page, context.json));
    },
  },
  'events retrieve': {
    usage: 'peable events retrieve <evt_…> [--json]',
    summary: 'Show one event',
    positionals: 1,
    async run(context) {
      const id = context.positionals[0];
      if (!id) throw new UsageError('an event id is required');
      const event = await (await context.peable()).events.retrieve(id);
      // An event is read for its payload: always the whole object.
      context.io.out(JSON.stringify(event, null, 2));
    },
  },

  'logs tail': {
    usage: 'peable logs tail [--status <404|4xx>] [--method <GET|POST|…>] [--json]',
    summary: 'Stream your test-mode API requests as they are answered',
    options: { status: { type: 'string' }, method: { type: 'string' } },
    async run(context) {
      testModeOnly(context, 'peable logs tail');
      await runLogsTail({
        peable: await context.peable(),
        io: context.io,
        status: parseStatusFilter(str(context.values, 'status')),
        method: parseMethod(str(context.values, 'method')),
        json: context.json,
        signal: context.io.interrupt,
      });
    },
  },

  'payment_intents list': {
    usage: 'peable payment_intents list [--status <status>] [--limit <n>] [--json]',
    summary: 'List payment intents',
    options: { ...LIST_OPTIONS, status: { type: 'string' } },
    async run(context) {
      const status = str(context.values, 'status');
      const page = await (await context.peable()).paymentIntents.list({
        ...listParams(context.values),
        ...(status ? { status: status as PaymentIntentStatus } : {}),
      });
      context.io.out(render(page, context.json));
    },
  },
  'payment_intents retrieve': {
    usage: 'peable payment_intents retrieve <pi_…> [--json]',
    summary: 'Show one payment intent',
    positionals: 1,
    async run(context) {
      const id = context.positionals[0];
      if (!id) throw new UsageError('a payment intent id is required');
      const intent = await (await context.peable()).paymentIntents.retrieve(id);
      context.io.out(render(intent, context.json));
    },
  },
  'payment_intents create': {
    usage:
      'peable payment_intents create --amount <base units> [--currency FAIR] [--rail faircoin|card] [--network testnet] [--metadata key=value]… [--json]',
    summary: 'Create a payment intent (FairCoin testnet by default)',
    options: PAYMENT_OPTIONS,
    async run(context) {
      const intent = await (await context.peable()).paymentIntents.create(
        paymentParams(context.values),
      );
      context.io.out(render(intent, context.json));
    },
  },

  'checkout_sessions create': {
    usage:
      'peable checkout_sessions create --amount <base units> [--currency] [--rail] [--network] [--success-url <url>] [--cancel-url <url>] [--metadata key=value]… [--json]',
    summary: 'Create a hosted checkout session',
    options: {
      ...PAYMENT_OPTIONS,
      'success-url': { type: 'string' },
      'cancel-url': { type: 'string' },
    },
    async run(context) {
      const { values } = context;
      const session = await (await context.peable()).checkout.sessions.create({
        ...paymentParams(values),
        ...(str(values, 'success-url') ? { success_url: str(values, 'success-url') } : {}),
        ...(str(values, 'cancel-url') ? { cancel_url: str(values, 'cancel-url') } : {}),
      });
      context.io.out(render(session, context.json));
    },
  },

  'webhook_endpoints list': {
    usage: 'peable webhook_endpoints list [--limit <n>] [--json]',
    summary: 'List webhook endpoints',
    options: LIST_OPTIONS,
    async run(context) {
      const page = await (await context.peable()).webhookEndpoints.list(listParams(context.values));
      context.io.out(render(page, context.json));
    },
  },
  'webhook_endpoints create': {
    usage:
      'peable webhook_endpoints create --url <https url> [--events <type,…|*>] [--description <text>] [--json]',
    summary: 'Register a webhook endpoint; prints its signing secret once',
    options: {
      url: { type: 'string' },
      events: { type: 'string' },
      description: { type: 'string' },
    },
    async run(context) {
      const { values } = context;
      const events = (str(values, 'events') ?? '*')
        .split(',')
        .map((type) => type.trim())
        .filter((type) => type !== '');
      const endpoint = await (await context.peable()).webhookEndpoints.create({
        url: required(values, 'url'),
        enabled_events: events as WebhookEnabledEvent[],
        ...(str(values, 'description') ? { description: str(values, 'description') } : {}),
      });
      context.io.out(render(endpoint, context.json));
      // The one time the gateway shows it. It is the endpoint's, not the CLI's,
      // and printing it is the point of this command.
      if (!context.json && endpoint.secret) {
        context.io.out(`Signing secret (shown once): ${endpoint.secret}`);
      }
    },
  },
  'webhook_endpoints delete': {
    usage: 'peable webhook_endpoints delete <we_…> [--json]',
    summary: 'Delete a webhook endpoint',
    positionals: 1,
    async run(context) {
      const id = context.positionals[0];
      if (!id) throw new UsageError('a webhook endpoint id is required');
      const deleted = await (await context.peable()).webhookEndpoints.del(id);
      context.io.out(render(deleted, context.json));
    },
  },
};

const GROUPS = new Set(
  Object.keys(COMMANDS)
    .filter((name) => name.includes(' '))
    .map((name) => name.split(' ')[0] ?? ''),
);

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    `peable ${CLI_VERSION} — the Peable command line`,
    '',
    'Usage: peable <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(
      ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
    ),
    '',
    'Global options:',
    '  --profile <name>   Which stored credential set (default: default, or $PEABLE_PROFILE)',
    '  --test | --live    Which mode of the profile (default: test)',
    '  --json             Print API objects as JSON',
    '  -h, --help         Help for a command',
    '  --version          Print the version',
  ].join('\n');
}

function describeError(error: PeableError): string {
  const details = [
    error.code ? `code: ${error.code}` : undefined,
    error.param ? `param: ${error.param}` : undefined,
    error.requestId ? `request: ${error.requestId}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Error: ${error.message}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    io.out(helpText());
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === 'version') {
    io.out(CLI_VERSION);
    return 0;
  }

  const [first = '', second = ''] = argv;
  const grouped = GROUPS.has(first);
  const name = grouped ? `${first} ${second}` : first;
  const command = COMMANDS[name];
  if (!command) {
    io.err(
      grouped
        ? `Unknown command: peable ${name}. Run \`peable --help\`.`
        : `Unknown command: ${first}. Run \`peable --help\`.`,
    );
    return 2;
  }

  try {
    const parsed = parseArgs({
      args: argv.slice(grouped ? 2 : 1) as string[],
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
    const values = parsed.values as Values;
    if (values.help === true) {
      io.out(`Usage: ${command.usage}\n\n${command.summary}.`);
      return 0;
    }
    if (parsed.positionals.length > (command.positionals ?? 0)) {
      throw new UsageError(`unexpected argument: ${parsed.positionals.join(' ')}`);
    }
    if (values.live === true && values.test === true) {
      throw new UsageError('pass --test or --live, not both');
    }
    const profile = str(values, 'profile') ?? io.env.PEABLE_PROFILE ?? DEFAULT_PROFILE;
    if (!isValidProfileName(profile)) throw new UsageError(`invalid profile name: ${profile}`);
    const mode: Mode = values.live === true ? 'live' : 'test';

    const context: Context = {
      io,
      values,
      positionals: parsed.positionals,
      profile,
      mode,
      json: values.json === true,
      async peable() {
        const config = await readConfig(configPath(io.env), io.err);
        const stored = config.profiles[profile];
        const credential = stored?.[mode];
        if (!credential) {
          throw new UsageError(
            `not logged in for ${mode} mode in profile '${profile}': run \`peable login${mode === 'live' ? ' --live' : ''}${profile === DEFAULT_PROFILE ? '' : ` --profile ${profile}`}\``,
          );
        }
        return new Peable({
          publicKey: credential.public_key,
          secret: credential.secret,
          ...(stored?.base_url ? { baseURL: stored.base_url } : {}),
          ...(stored?.oxy_api_url ? { oxyApiUrl: stored.oxy_api_url } : {}),
        });
      },
    };
    await command.run(context);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`Error: ${error.message}`);
      return 2;
    }
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      io.err(`Error: ${error.message}\nUsage: ${command.usage}`);
      return 2;
    }
    if (error instanceof PeableError) {
      io.err(describeError(error));
      return 1;
    }
    if (error instanceof FixtureUnavailableError) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

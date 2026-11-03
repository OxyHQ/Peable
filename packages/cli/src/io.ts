import { createInterface } from 'node:readline';

/**
 * Everything a command touches outside itself, injected so a suite can run the
 * real command against a temporary config and a local gateway.
 */
export interface Io {
  readonly env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  /** Ask a question and read one visible line. */
  prompt(question: string): Promise<string>;
  /**
   * Read a secret: hidden typing on a terminal, or all of standard input when
   * it is piped (`echo "$SECRET" | peable login …`). Never echoed.
   */
  readSecret(question: string): Promise<string>;
  /** Aborted on Ctrl-C: how a long-running command (`listen`, `logs tail`) ends. */
  readonly interrupt: AbortSignal;
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text.trim();
}

/** The process's own terminal. */
export function processIo(): Io {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  return {
    env: process.env,
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
    prompt: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }),
    readSecret: async (question) => {
      const input = process.stdin;
      if (!input.isTTY) return readAll(input);
      process.stderr.write(question);
      return new Promise((resolve, reject) => {
        let value = '';
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        const done = (error?: Error) => {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stderr.write('\n');
          if (error) reject(error);
          else resolve(value.trim());
        };
        const onData = (chunk: string) => {
          for (const char of chunk) {
            if (char === '\r' || char === '\n' || char === '\u0004') return done();
            if (char === '\u0003') return done(new Error('cancelled'));
            if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
            else value += char;
          }
        };
        input.on('data', onData);
      });
    },
    interrupt: controller.signal,
  };
}

/**
 * The customer-email transport — an INJECTED interface (Orbit Phase 3).
 *
 * Peable composes its receipts, refund notices and checkout confirmations and
 * hands each to a `Mailer`. Production wires a mailer over Oxy's outbound mail
 * relay (`~/Oxy/docs/outbound-mail-relay.md`): no shared Oxy package exposes a
 * transactional-mail client today, so the production implementation is an
 * adapter to whichever the relay offers Peable — SMTP submission with Peable's
 * own SASL account on the relay list, or a service-authenticated oxy-api send
 * endpoint — registered with `configureMailer` at boot. Until one is
 * registered the outbox keeps its rows `pending` (and expires them after their
 * window); nothing pretends an email was sent.
 *
 * Development and tests use {@link MemoryMailer} (records what it would send)
 * or {@link LogMailer} (`PEABLE_MAIL_TRANSPORT=log`: logs the kind and the
 * recipient's DOMAIN only — never a body, never a full address).
 */

export interface OutboundEmail {
  readonly to: string;
  /** The merchant's support address, when it set one. */
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Stable across retries of one email (`X-Peable-Email-Id`), so a relay that
   * deduplicates can, and an operator can trace one send without its content.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface Mailer {
  readonly name: string;
  /** Resolves when the relay ACCEPTED the message. Throws on refusal or transport failure. */
  send(email: OutboundEmail): Promise<{ readonly messageId: string }>;
}

/**
 * The relay refused THIS message (a 5xx, a suppressed recipient): retrying it
 * cannot help, so the outbox marks it `failed` instead of backing off.
 */
export class MailerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailerRefusedError';
  }
}

/** Records every email instead of sending it — the test transport. */
export class MemoryMailer implements Mailer {
  readonly name = 'memory';
  readonly sent: OutboundEmail[] = [];
  private failures: Error[] = [];

  /** Make the next `send`s throw these, in order. */
  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(email);
    return { messageId: `memory-${this.sent.length}` };
  }
}

/** Logs that an email WOULD be sent, with no content and no full address. */
export class LogMailer implements Mailer {
  readonly name = 'log';
  private counter = 0;
  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    this.counter += 1;
    const domain = email.to.split('@')[1] ?? '?';
    console.info(
      `[peable mail] ${email.headers['X-Peable-Email-Kind'] ?? 'email'} to *@${domain} (${email.headers['X-Peable-Email-Id'] ?? '-'})`,
    );
    return { messageId: `log-${this.counter}` };
  }
}

let configured: Mailer | null = null;

/** Register the transport (boot), or `null` to stop sending. */
export function configureMailer(mailer: Mailer | null): void {
  configured = mailer;
}

export function currentMailer(): Mailer | null {
  return configured;
}

/** The transport `PEABLE_MAIL_TRANSPORT` names: `log` in development, none otherwise. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  return env.PEABLE_MAIL_TRANSPORT === 'log' ? new LogMailer() : null;
}

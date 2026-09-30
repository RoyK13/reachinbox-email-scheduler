import nodemailer, { type SentMessageInfo, type Transporter } from 'nodemailer';
import type { Sender } from '@prisma/client';
import { smtpCredentials } from './sender.service';

export interface OutgoingEmail {
  /** The author shown to the recipient (the signed-in user). Replies go here too. */
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable Message-ID so the recipient side can de-duplicate if a resend ever occurs. */
  messageId: string;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
  accepted: string[];
  rejected: string[];
}

/** Minimal transport surface — lets tests inject a stub without faking production code paths. */
export interface MailTransport {
  sendMail(options: nodemailer.SendMailOptions): Promise<SentMessageInfo>;
  close(): void;
}

export type TransportFactory = (sender: Sender) => MailTransport;

/**
 * SMTP error codes raised by Nodemailer *before* the server accepted the
 * message (connection/auth/greeting stage). Retrying these cannot duplicate
 * a delivered email. Anything else is treated as non-retryable.
 */
const ALWAYS_PRE_ACCEPTANCE = new Set(['ECONNECTION', 'EDNS', 'EAUTH', 'ETLS', 'ECONNREFUSED']);
/** Timeouts/socket drops are only safe when they happened before DATA was issued. */
const AMBIGUOUS = new Set(['ETIMEDOUT', 'ESOCKET']);
const PRE_DATA_COMMAND = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/i;

export function isSafeToRetrySmtpError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, command } = err as { code?: string; command?: string };
  if (!code) return false;
  if (ALWAYS_PRE_ACCEPTANCE.has(code)) return true;
  // Once DATA has been issued the server may already have accepted the message,
  // so a timeout there is an unknown outcome — never retried.
  return AMBIGUOUS.has(code) && typeof command === 'string' && PRE_DATA_COMMAND.test(command);
}

export const smtpTransportFactory: TransportFactory = (sender) => {
  const creds = smtpCredentials(sender);
  const transporter: Transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  return transporter;
};

/**
 * Sends through the sender's own SMTP account (Ethereal). One pooled
 * transporter per sender, rebuilt when the sender's credentials change.
 */
export class MailService {
  private readonly transports = new Map<string, { version: number; transport: MailTransport }>();

  constructor(private readonly factory: TransportFactory = smtpTransportFactory) {}

  private transportFor(sender: Sender): MailTransport {
    const version = sender.updatedAt.getTime();
    const cached = this.transports.get(sender.id);
    if (cached && cached.version === version) return cached.transport;
    cached?.transport.close();
    const transport = this.factory(sender);
    this.transports.set(sender.id, { version, transport });
    return transport;
  }

  async send(sender: Sender, email: OutgoingEmail): Promise<SendResult> {
    // The user is the author (From / Reply-To); the sender account is only the
    // SMTP transport, exposed as the Sender header and the envelope MAIL FROM.
    const info = await this.transportFor(sender).sendMail({
      from: email.from,
      replyTo: email.from,
      sender: { name: sender.name, address: sender.email },
      envelope: { from: sender.email, to: email.to },
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      messageId: email.messageId,
      attachments: email.attachments ?? [],
    });
    const preview = nodemailer.getTestMessageUrl(info);
    return {
      messageId: String(info.messageId ?? email.messageId),
      previewUrl: typeof preview === 'string' ? preview : null,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  closeAll(): void {
    for (const { transport } of this.transports.values()) transport.close();
    this.transports.clear();
  }
}

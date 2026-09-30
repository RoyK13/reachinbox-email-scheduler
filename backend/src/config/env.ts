import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/**
 * Ethereal sender entry. Credentials come only from the environment
 * (ETHEREAL_SENDERS_JSON) — never from source control.
 */
const senderConfigSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  user: z.string().min(1),
  pass: z.string().min(1),
  host: z.string().min(1).default('smtp.ethereal.email'),
  port: z.coerce.number().int().positive().default(587),
  secure: z.boolean().default(false),
});

export type SenderConfig = z.infer<typeof senderConfigSchema>;

const sendersJson = z.string().transform((raw, ctx) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = z.array(senderConfigSchema).min(1).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a JSON array of {name,email,user,pass[,host,port,secure]}: ${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      });
      return z.NEVER;
    }
    return result.data;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
    return z.NEVER;
  }
});

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ELASTICSEARCH_URL: z.string().url(),
  ELASTICSEARCH_INDEX: z.string().min(1).default('emails'),
  /** Elastic Cloud API key (base64 "id:key"). Optional: local Docker ES has no auth. */
  ELASTICSEARCH_API_KEY: z.string().trim().min(1).optional(),

  SESSION_SECRET: z.string().min(16, 'must be at least 16 characters'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),

  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_REDIRECT_URI: z.string().url(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(10),
  MIN_EMAIL_DELAY_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  SENDING_STALE_MS: z.coerce.number().int().min(10_000).default(300_000),
  MAX_RECIPIENTS_PER_REQUEST: z.coerce.number().int().min(1).max(100_000).default(10_000),

  BULL_BOARD_ENABLED: booleanString.default('true'),
  /** Built frontend to serve (single-service deploys). Default: ../frontend/dist if it exists. */
  FRONTEND_DIST_DIR: z.string().min(1).optional(),
  QUEUE_NAME: z.string().min(1).default('email-send'),

  ETHEREAL_SENDERS_JSON: sendersJson,
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Logger depends on config, so this one message goes straight to stderr.
    process.stderr.write(
      `\nInvalid or missing environment configuration:\n${lines.join('\n')}\n\n` +
        'Copy backend/.env.example to backend/.env and fill in the values.\n\n',
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

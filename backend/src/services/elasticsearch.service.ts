import { Client, errors as esErrors } from '@elastic/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import type { Email, EmailStatus, Sender } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import type { Paginated } from '../types/api';
import type { EmailListItem, EmailListKind, EmailSearchDocument } from '../types/email';
import { errorMessage } from '../utils/errors';

export const esClient = new Client({
  node: env.ELASTICSEARCH_URL,
  ...(env.ELASTICSEARCH_API_KEY ? { auth: { apiKey: env.ELASTICSEARCH_API_KEY } } : {}),
  requestTimeout: 10_000,
  maxRetries: 2,
});

export const LIST_STATUSES: Record<EmailListKind, EmailStatus[]> = {
  scheduled: ['SCHEDULED', 'SENDING'],
  sent: ['SENT', 'FAILED'],
};

// No shard/replica counts: Elastic Cloud Serverless rejects them, and the
// defaults are fine for self-managed clusters too.
const INDEX_SETTINGS: estypes.IndicesIndexSettings = {
  analysis: {
    normalizer: {
      lowercase_normalizer: { type: 'custom', filter: ['lowercase', 'asciifolding'] },
    },
  },
};

const INDEX_MAPPINGS: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: {
    id: { type: 'keyword' },
    userId: { type: 'keyword' },
    campaignId: { type: 'keyword' },
    senderId: { type: 'keyword' },
    senderEmail: { type: 'keyword', normalizer: 'lowercase_normalizer' },
    recipientEmail: {
      type: 'keyword',
      normalizer: 'lowercase_normalizer',
      fields: { sayt: { type: 'search_as_you_type' } },
    },
    subject: {
      type: 'text',
      fields: {
        keyword: { type: 'keyword', ignore_above: 512 },
        sayt: { type: 'search_as_you_type' },
      },
    },
    bodyPreview: { type: 'text', index: false },
    status: { type: 'keyword' },
    etherealPreviewUrl: { type: 'keyword', index: false },
    errorMessage: { type: 'text', index: false },
    sequenceNumber: { type: 'integer' },
    scheduledAt: { type: 'date' },
    sentAt: { type: 'date' },
    failedAt: { type: 'date' },
    completedAt: { type: 'date' },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
};

export type EmailWithSender = Email & { sender: Pick<Sender, 'email'> };

const PREVIEW_LENGTH = 160;

export function toSearchDocument(email: EmailWithSender): EmailSearchDocument {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: email.id,
    userId: email.userId,
    campaignId: email.campaignId,
    senderId: email.senderId,
    senderEmail: email.sender.email,
    recipientEmail: email.recipientEmail,
    subject: email.subject,
    bodyPreview: htmlPreview(email.body),
    status: email.status,
    etherealPreviewUrl: email.etherealPreviewUrl,
    errorMessage: email.errorMessage,
    sequenceNumber: email.sequenceNumber,
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: iso(email.sentAt),
    failedAt: iso(email.failedAt),
    completedAt: iso(email.sentAt ?? email.failedAt),
    createdAt: email.createdAt.toISOString(),
    updatedAt: email.updatedAt.toISOString(),
  };
}

function htmlPreview(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

function toListItem(doc: EmailSearchDocument): EmailListItem {
  return {
    id: doc.id,
    recipientEmail: doc.recipientEmail,
    subject: doc.subject,
    bodyPreview: doc.bodyPreview,
    status: doc.status,
    senderId: doc.senderId,
    senderEmail: doc.senderEmail,
    scheduledAt: doc.scheduledAt,
    sentAt: doc.sentAt,
    failedAt: doc.failedAt,
    etherealPreviewUrl: doc.etherealPreviewUrl,
    errorMessage: doc.errorMessage,
  };
}

export interface SearchParams {
  userId: string;
  kind: EmailListKind;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

/**
 * Elasticsearch abstraction. PostgreSQL stays the source of truth: every write
 * here is best-effort (logged, never thrown) so an ES outage can't turn a
 * successful send into a failure. `npm run reindex` rebuilds the index from DB.
 */
export class ElasticsearchService {
  constructor(
    private readonly client: Client = esClient,
    readonly index: string = env.ELASTICSEARCH_INDEX,
  ) {}

  async ping(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  /** Create the index with explicit mappings if it doesn't exist yet. */
  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.index });
    if (exists) return;
    try {
      await this.client.indices.create({ index: this.index, settings: INDEX_SETTINGS, mappings: INDEX_MAPPINGS });
      logger.info({ index: this.index }, 'elasticsearch index created');
    } catch (err) {
      // Another process created it between exists() and create().
      if (err instanceof esErrors.ResponseError && err.body?.error?.type === 'resource_already_exists_exception') return;
      throw err;
    }
  }

  async deleteIndex(): Promise<void> {
    await this.client.indices.delete({ index: this.index, ignore_unavailable: true });
  }

  async refresh(): Promise<void> {
    await this.client.indices.refresh({ index: this.index });
  }

  /** Bulk upsert. Returns the number of documents that failed (0 on success). */
  async indexEmails(emails: EmailWithSender[], opts: { refresh?: boolean } = {}): Promise<number> {
    if (emails.length === 0) return 0;
    try {
      const operations = emails.flatMap((email) => [
        { index: { _index: this.index, _id: email.id } },
        toSearchDocument(email),
      ]);
      const res = await this.client.bulk({ operations, refresh: opts.refresh ? 'wait_for' : false });
      if (!res.errors) return 0;
      const failed = res.items.filter((item) => item.index?.error);
      logger.error(
        { failed: failed.length, sample: failed[0]?.index?.error?.reason },
        'elasticsearch bulk index had failures (run `npm run reindex` to repair)',
      );
      return failed.length;
    } catch (err) {
      logger.error({ err: errorMessage(err), count: emails.length }, 'elasticsearch bulk index failed');
      return emails.length;
    }
  }

  async indexEmail(email: EmailWithSender, opts: { refresh?: boolean } = {}): Promise<boolean> {
    return (await this.indexEmails([email], opts)) === 0;
  }

  async search(params: SearchParams): Promise<Paginated<EmailListItem>> {
    const q = params.q?.trim().toLowerCase();
    const filter: estypes.QueryDslQueryContainer[] = [
      // Tenant isolation: always enforced server-side from the session user.
      { term: { userId: params.userId } },
      { terms: { status: LIST_STATUSES[params.kind] } },
    ];

    const must: estypes.QueryDslQueryContainer[] = [];
    if (q) {
      must.push({
        bool: {
          minimum_should_match: 1,
          should: [
            {
              multi_match: {
                query: q,
                type: 'bool_prefix',
                operator: 'and',
                fields: [
                  'subject.sayt^2',
                  'subject.sayt._2gram^2',
                  'subject.sayt._3gram^2',
                  'recipientEmail.sayt',
                  'recipientEmail.sayt._2gram',
                  'recipientEmail.sayt._3gram',
                ],
              },
            },
            { match: { subject: { query: q, fuzziness: 'AUTO', operator: 'and', boost: 1.5 } } },
            { wildcard: { recipientEmail: { value: `*${escapeWildcard(q)}*`, case_insensitive: true } } },
          ],
        },
      });
    }

    const sort: estypes.Sort =
      params.kind === 'scheduled'
        ? [{ scheduledAt: 'asc' }, { sequenceNumber: 'asc' }, { id: 'asc' }]
        : [{ completedAt: { order: 'desc', missing: '_last' } }, { id: 'asc' }];

    const res = await this.client.search<EmailSearchDocument>({
      index: this.index,
      from: (params.page - 1) * params.pageSize,
      size: params.pageSize,
      track_total_hits: true,
      query: { bool: { filter, must } },
      sort,
    });

    const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
    const items = res.hits.hits.flatMap((hit) => (hit._source ? [toListItem(hit._source)] : []));
    return {
      items,
      page: params.page,
      pageSize: params.pageSize,
      total,
      totalPages: Math.ceil(total / params.pageSize),
    };
  }
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, (c) => `\\${c}`);
}

export const searchService = new ElasticsearchService();

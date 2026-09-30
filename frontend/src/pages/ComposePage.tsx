import { ArrowLeft, FileText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AttachButton,
  AttachmentTiles,
  MAX_ATTACHMENTS,
  validateAttachment,
  type ComposeAttachment,
} from '../components/compose/Attachments';
import { RecipientField } from '../components/compose/RecipientField';
import { RichTextEditor } from '../components/compose/RichTextEditor';
import { SendLaterPopover } from '../components/compose/SendLaterPopover';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { FileUpload } from '../components/ui/FileUpload';
import { FieldRow, Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { useSchedule, useSenders } from '../hooks/queries';
import { useDashboardUser } from '../layouts/DashboardLayout';
import { api, ApiError } from '../services/api';
import type { ScheduleResult } from '../types';
import { formatDateTime, formatNumber, LOCAL_TIME_ZONE, localInputToUtcIso } from '../utils/format';
import { parseLeadsFile, type ParsedLeads } from '../utils/parseLeads';

const MAX_RECIPIENTS = 10_000;
/** "Send" without a time: give the worker a moment rather than a past timestamp. */
const SEND_NOW_OFFSET_MS = 10_000;

type Errors = Partial<Record<'recipients' | 'subject' | 'body' | 'delay' | 'hourlyLimit' | 'startTime', string>>;

export function ComposePage() {
  const user = useDashboardUser();
  const navigate = useNavigate();
  const senders = useSenders();
  const schedule = useSchedule();

  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [leadInfo, setLeadInfo] = useState<(ParsedLeads & { fileName: string }) | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState({ html: '', empty: true });
  const [delaySeconds, setDelaySeconds] = useState('2');
  const [hourlyLimit, setHourlyLimit] = useState('200');
  const [sendAt, setSendAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [result, setResult] = useState<ScheduleResult | null>(null);
  // One key per compose session: double-clicks / retries can never schedule twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const enabledSenders = useMemo(() => senders.data?.filter((s) => s.enabled) ?? [], [senders.data]);
  const noSenders = senders.isSuccess && enabledSenders.length === 0;
  const [senderId, setSenderId] = useState<string>('all');

  // Revoke image preview URLs when leaving the page.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)),
    [],
  );

  const patchAttachment = (localId: string, patch: Partial<ComposeAttachment>) =>
    setAttachments((list) => list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));

  function addAttachments(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (files.length > room) toast.error(`You can attach at most ${MAX_ATTACHMENTS} files`);
    for (const file of files.slice(0, Math.max(room, 0))) {
      const localId = crypto.randomUUID();
      const problem = validateAttachment(file);
      const item: ComposeAttachment = {
        localId,
        file,
        status: problem ? 'error' : 'uploading',
        progress: 0,
        ...(problem ? { error: problem } : {}),
        ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
      setAttachments((list) => [...list, item]);
      if (problem) continue;
      api
        .uploadAttachment(file, (progress) => patchAttachment(localId, { progress }))
        .then((uploaded) => patchAttachment(localId, { status: 'done', id: uploaded.id }))
        .catch((err: unknown) =>
          patchAttachment(localId, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }),
        );
    }
  }

  function removeAttachment(localId: string) {
    const item = attachments.find((a) => a.localId === localId);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    // Best effort: drop the unscheduled upload server-side too.
    if (item?.id) void api.deleteAttachment(item.id).catch(() => undefined);
    setAttachments((list) => list.filter((a) => a.localId !== localId));
  }

  async function handleFile(file: File) {
    try {
      const parsed = await parseLeadsFile(file);
      if (parsed.emails.length === 0) {
        toast.error(`No valid email addresses found in ${file.name}`);
        return;
      }
      const merged = Array.from(new Set([...recipients, ...parsed.emails]));
      setRecipients(merged);
      setLeadInfo({ ...parsed, fileName: file.name });
      setErrors((e) => ({ ...e, recipients: undefined }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read file');
    }
  }

  function validate(): Errors {
    const next: Errors = {};
    if (recipients.length === 0) next.recipients = 'Add at least one recipient or upload a lead list';
    else if (recipients.length > MAX_RECIPIENTS) next.recipients = `At most ${formatNumber(MAX_RECIPIENTS)} recipients per campaign`;
    if (!subject.trim()) next.subject = 'Subject is required';
    if (body.empty) next.body = 'Write a message';
    const delay = Number(delaySeconds);
    if (!Number.isFinite(delay) || delay <= 0) next.delay = 'Delay must be greater than 0 seconds';
    const limit = Number(hourlyLimit);
    if (!Number.isInteger(limit) || limit <= 0) next.hourlyLimit = 'Hourly limit must be a positive whole number';
    if (sendAt && new Date(sendAt).getTime() <= Date.now()) next.startTime = 'Pick a time in the future';
    return next;
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      toast.error('Please fix the highlighted fields');
      return;
    }
    if (attachments.some((a) => a.status === 'uploading')) {
      toast.error('Wait for attachments to finish uploading');
      return;
    }
    if (attachments.some((a) => a.status === 'error')) {
      toast.error('Remove the attachments that failed before sending');
      return;
    }
    const startTime = sendAt ? localInputToUtcIso(sendAt) : new Date(Date.now() + SEND_NOW_OFFSET_MS).toISOString();
    schedule.mutate(
      {
        subject: subject.trim(),
        body: body.html,
        recipients,
        startTime,
        delayBetweenEmailsMs: Math.round(Number(delaySeconds) * 1000),
        hourlyLimit: Number(hourlyLimit),
        idempotencyKey,
        attachmentIds: attachments.flatMap((a) => (a.id ? [a.id] : [])),
        ...(senderId !== 'all' ? { senderIds: [senderId] } : {}),
      },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(`${formatNumber(res.totalRecipients)} emails scheduled`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'IDEMPOTENCY_CONFLICT') setIdempotencyKey(crypto.randomUUID());
          toast.error(err.message);
        },
      },
    );
  }

  const primaryLabel = sendAt ? 'Send Later' : 'Send';

  return (
    <form onSubmit={submit} className="flex h-full flex-col overflow-y-auto" noValidate>
      {/* Header — Figma: "← Compose New Email" + paperclip + clock + Send / Send Later */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-white px-4 py-4 md:px-6">
        <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="rounded p-1 hover:bg-surface">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="flex-1 text-xl font-medium">Compose New Email</h1>
        <AttachButton count={attachments.length} onFiles={addAttachments} disabled={attachments.length >= MAX_ATTACHMENTS} />
        <SendLaterPopover value={sendAt} onChange={setSendAt} />
        <Button
          type="submit"
          variant="outline"
          pill
          loading={schedule.isPending}
          disabled={attachments.some((a) => a.status === 'uploading')}
          className="min-w-24"
        >
          {primaryLabel}
        </Button>
      </div>

      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-10 md:px-6">
        {sendAt && (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
            Scheduled start: <strong>{formatDateTime(new Date(sendAt).toISOString())}</strong> ({LOCAL_TIME_ZONE}) — sent to the
            server as {localInputToUtcIso(sendAt)}
          </p>
        )}
        {errors.startTime && <p className="text-sm text-red-600">{errors.startTime}</p>}

        <FieldRow label="From">
          <div className="inline-flex h-9 max-w-full items-center gap-2 rounded-md bg-surface px-3 text-sm" title={user.email}>
            <Avatar name={user.name} src={user.avatarUrl} size={20} />
            <span className="truncate">{user.email}</span>
          </div>
        </FieldRow>

        <FieldRow label="Send via" htmlFor="compose-via">
          <select
            id="compose-via"
            value={senderId}
            onChange={(e) => setSenderId(e.target.value)}
            disabled={senders.isPending || noSenders}
            className="h-9 max-w-full rounded-md bg-surface px-3 pr-8 text-sm outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="all">
              {senders.isPending
                ? 'Loading sending accounts…'
                : `All Ethereal accounts (round-robin, ${enabledSenders.length})`}
            </option>
            {enabledSenders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} &lt;{s.email}&gt;
              </option>
            ))}
          </select>
          {senders.isError && <p className="mt-1 text-xs text-red-600">Couldn’t load sending accounts: {senders.error.message}</p>}
          {noSenders && (
            <p className="mt-1 text-xs text-red-600">No sending accounts are configured (ETHEREAL_SENDERS_JSON).</p>
          )}
        </FieldRow>

        <FieldRow label="To" htmlFor="compose-to" error={errors.recipients}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <RecipientField
                recipients={recipients}
                onChange={(next) => {
                  setRecipients(next);
                  if (next.length === 0) setLeadInfo(null);
                }}
                invalid={Boolean(errors.recipients)}
              />
            </div>
            <div className="pt-1.5">
              <FileUpload onFile={(f) => void handleFile(f)} />
            </div>
          </div>
          {recipients.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="font-medium text-brand-700">{formatNumber(recipients.length)} email addresses detected</span>
              {leadInfo && (
                <span className="inline-flex items-center gap-1">
                  <FileText className="size-3" aria-hidden />
                  {leadInfo.fileName}
                  {leadInfo.column ? ` (column “${leadInfo.column}”)` : ''}
                  {leadInfo.invalid > 0 && ` · ${formatNumber(leadInfo.invalid)} invalid ignored`}
                  {leadInfo.duplicates > 0 && ` · ${formatNumber(leadInfo.duplicates)} duplicates removed`}
                </span>
              )}
              <button
                type="button"
                className="text-muted underline-offset-2 hover:underline"
                onClick={() => {
                  setRecipients([]);
                  setLeadInfo(null);
                }}
              >
                Clear all
              </button>
            </p>
          )}
        </FieldRow>

        <FieldRow label="Subject" htmlFor="compose-subject" error={errors.subject}>
          <Input
            id="compose-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            maxLength={998}
            aria-invalid={Boolean(errors.subject)}
          />
        </FieldRow>

        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 sm:pl-[108px]">
          <label className="flex items-center gap-2 text-sm whitespace-nowrap text-ink">
            Delay between 2 emails
            <Input
              type="number"
              min={0.1}
              step={0.1}
              inputMode="decimal"
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(e.target.value)}
              className="w-20"
              aria-invalid={Boolean(errors.delay)}
            />
            <span className="text-muted">sec</span>
          </label>
          <label className="flex items-center gap-2 text-sm whitespace-nowrap text-ink">
            Hourly Limit
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(e.target.value)}
              className="w-24"
              aria-invalid={Boolean(errors.hourlyLimit)}
            />
            <span className="text-muted">emails/hour</span>
          </label>
        </div>
        {(errors.delay || errors.hourlyLimit) && (
          <p className="text-xs text-red-600 sm:pl-[108px]">{errors.delay ?? errors.hourlyLimit}</p>
        )}

        <div>
          <RichTextEditor onChange={(html, empty) => setBody({ html, empty })} invalid={Boolean(errors.body)} />
          {errors.body && <p className="mt-1 text-xs text-red-600">{errors.body}</p>}
        </div>

        <AttachmentTiles items={attachments} onRemove={removeAttachment} />
      </div>

      <Modal
        open={Boolean(result)}
        title={result?.idempotentReplay ? 'Already scheduled' : 'Campaign scheduled'}
        onClose={() => navigate('/scheduled')}
        footer={
          <Button variant="primary" onClick={() => navigate('/scheduled')}>
            View scheduled emails
          </Button>
        }
      >
        {result && (
          <dl className="grid grid-cols-[150px_1fr] gap-y-2">
            <dt className="text-muted">Emails</dt>
            <dd className="font-medium">{formatNumber(result.totalRecipients)}</dd>
            <dt className="text-muted">First send</dt>
            <dd>{formatDateTime(result.firstScheduledAt)}</dd>
            <dt className="text-muted">Last (planned)</dt>
            <dd>{formatDateTime(result.lastScheduledAt)}</dd>
            <dt className="text-muted">Delay / hourly limit</dt>
            <dd>
              {result.effectiveDelayBetweenEmailsMs / 1000}s · {formatNumber(result.effectiveHourlyLimit)}/hour per sender
            </dd>
            <dt className="text-muted">Senders</dt>
            <dd className="space-y-0.5">
              {result.senders.map((s) => (
                <div key={s.id} className="truncate">
                  {s.email} <span className="text-muted">× {formatNumber(s.assigned)}</span>
                </div>
              ))}
            </dd>
          </dl>
        )}
      </Modal>
    </form>
  );
}

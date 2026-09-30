import { X } from 'lucide-react';
import { useState } from 'react';
import { formatNumber } from '../../utils/format';
import { isValidEmail, normalizeEmail } from '../../utils/parseLeads';

const VISIBLE_CHIPS = 3;

/**
 * Figma "To" row: recipient chips with a "+N" overflow chip. Addresses can be
 * typed (Enter / comma / paste) or come from an uploaded lead list.
 */
export function RecipientField({
  recipients,
  onChange,
  invalid,
}: {
  recipients: string[];
  onChange: (next: string[]) => void;
  invalid?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const commit = (text: string) => {
    const parts = text.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.filter((p) => !isValidEmail(p));
    const good = parts.filter((p) => isValidEmail(p));
    if (good.length) {
      const set = new Set(recipients);
      onChange([...recipients, ...good.filter((g) => !set.has(g) && set.add(g))]);
    }
    setDraft(bad.join(', '));
    setDraftError(bad.length ? `Not a valid email: ${bad[0]}` : null);
  };

  // Expanded view is capped so a 10k-lead list doesn't render 10k chips.
  const shown = recipients.slice(0, expanded ? 200 : VISIBLE_CHIPS);
  const hidden = recipients.length - shown.length;

  return (
    <div>
      <div
        className={`flex min-h-9 flex-wrap items-center gap-1.5 rounded-md px-1 py-1 ring-1 ${
          invalid ? 'ring-red-300' : 'ring-transparent'
        } ${expanded ? 'max-h-40 overflow-y-auto' : ''}`}
      >
        {shown.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-full border border-brand-500 bg-white px-2 py-0.5 text-xs text-ink"
          >
            {email}
            <button
              type="button"
              aria-label={`Remove ${email}`}
              className="text-faint hover:text-ink"
              onClick={() => onChange(recipients.filter((r) => r !== email))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            disabled={expanded}
            onClick={() => setExpanded(true)}
            className="rounded-full border border-brand-500 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
          >
            +{formatNumber(hidden)}
          </button>
        )}
        {expanded && recipients.length > VISIBLE_CHIPS && (
          <button type="button" onClick={() => setExpanded(false)} className="px-1 text-xs text-muted hover:underline">
            Show less
          </button>
        )}
        <input
          id="compose-to"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDraftError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && !draft && recipients.length) {
              onChange(recipients.slice(0, -1));
            }
          }}
          onBlur={() => draft && commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[\s,;]/.test(text.trim())) {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder={recipients.length ? '' : 'recipient@example.com'}
          className="h-7 min-w-40 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-faint"
        />
      </div>
      {draftError && <p className="mt-1 text-xs text-red-600">{draftError}</p>}
    </div>
  );
}

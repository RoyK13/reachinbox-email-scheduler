import { CalendarClock, Clock } from 'lucide-react';
import { useState } from 'react';
import { LOCAL_TIME_ZONE, toLocalInputValue } from '../../utils/format';
import { Button, IconButton } from '../ui/Button';
import { Popover } from '../ui/Popover';

function tomorrowAt(hour: number | null): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (hour === null) d.setHours(9, 0, 0, 0);
  else d.setHours(hour, 0, 0, 0);
  return d;
}

const PRESETS: Array<{ label: string; at: () => Date }> = [
  { label: 'Tomorrow', at: () => tomorrowAt(null) },
  { label: 'Tomorrow, 10:00 AM', at: () => tomorrowAt(10) },
  { label: 'Tomorrow, 11:00 AM', at: () => tomorrowAt(11) },
  { label: 'Tomorrow, 3:00 PM', at: () => tomorrowAt(15) },
];

/**
 * Figma "Send Later" popover: pick date & time or a preset, Cancel / Done.
 * The value is a local datetime-local string; the page converts it to UTC ISO.
 */
export function SendLaterPopover({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const min = toLocalInputValue(new Date(Date.now() + 60_000));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(value ?? '');
      }}
      trigger={({ toggle }) => (
        <IconButton label="Send later" onClick={toggle} className={value ? 'text-brand-700' : ''}>
          <Clock className="size-5" />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="w-72 p-4">
          <p className="mb-3 text-sm font-semibold">Send Later</p>
          <label className="flex items-center gap-2 border-b border-line pb-2 text-sm">
            <span className="sr-only">Pick date &amp; time</span>
            <input
              type="datetime-local"
              value={draft}
              min={min}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 bg-transparent text-sm text-ink outline-none"
            />
            <CalendarClock className="size-4 text-faint" aria-hidden />
          </label>
          <p className="mt-1 text-[11px] text-faint">Your time zone: {LOCAL_TIME_ZONE}</p>
          <ul className="mt-3 space-y-0.5">
            {PRESETS.map((p) => (
              <li key={p.label}>
                <button
                  type="button"
                  onClick={() => setDraft(toLocalInputValue(p.at()))}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface ${
                    draft === toLocalInputValue(p.at()) ? 'bg-brand-50 font-medium' : ''
                  }`}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-end gap-2">
            {value && (
              <button
                type="button"
                className="mr-auto text-xs text-muted hover:underline"
                onClick={() => {
                  onChange(null);
                  close();
                }}
              >
                Clear
              </button>
            )}
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              pill
              disabled={!draft}
              onClick={() => {
                onChange(draft || null);
                close();
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

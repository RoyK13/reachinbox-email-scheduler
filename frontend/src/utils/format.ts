export const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const weekdayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fullDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Tue 9:15:12 AM" within the next/last week (as in the Figma pill), otherwise "Oct 3, 9:15 AM". */
export function formatPillTime(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.abs(d.getTime() - Date.now()) / 86_400_000;
  return diffDays < 6 ? weekdayTime.format(d) : dateTime.format(d);
}

export function formatDateTime(iso: string): string {
  return fullDateTime.format(new Date(iso));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Value for <input type="datetime-local"> in the browser's local zone. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local datetime-local string → UTC ISO (what the API expects). */
export function localInputToUtcIso(value: string): string {
  return new Date(value).toISOString();
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

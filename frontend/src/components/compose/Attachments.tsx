import { AlertCircle, FileText, Loader2, Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import { formatBytes } from '../../utils/format';
import { IconButton } from '../ui/Button';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const BLOCKED = /\.(exe|dll|bat|cmd|com|scr|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|jar|app|sh|cpl|hta|lnk|reg|iso|img)$/i;

export interface ComposeAttachment {
  localId: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  id?: string;
  error?: string;
  /** Object URL for image thumbnails. */
  previewUrl?: string;
}

/** Client-side pre-check; the server enforces the same rules. */
export function validateAttachment(file: File): string | null {
  if (BLOCKED.test(file.name)) return 'Executable and script files cannot be attached';
  if (file.size === 0) return 'File is empty';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'Each file must be at most 5 MB';
  return null;
}

/** Figma paperclip (with count badge) that opens the file picker. */
export function AttachButton({ count, onFiles, disabled }: { count: number; onFiles: (files: File[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        label={count ? `${count} attachment${count > 1 ? 's' : ''} — add more` : 'Attach files'}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className={`relative ${count ? 'text-brand-700' : ''}`}
      >
        <Paperclip className="size-5" />
        {count > 0 && (
          <span className="absolute right-0.5 bottom-0.5 min-w-3.5 rounded-full bg-white text-[10px] leading-3.5 font-semibold text-brand-700">
            {count}
          </span>
        )}
      </IconButton>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Figma shows attachments as tiles under the editor (image thumbnails / file cards). */
export function AttachmentTiles({ items, onRemove }: { items: ComposeAttachment[]; onRemove: (localId: string) => void }) {
  if (items.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-3" aria-label="Attachments">
      {items.map((a) => (
        <li
          key={a.localId}
          className={`group relative w-40 overflow-hidden rounded-lg border bg-white text-xs ${
            a.status === 'error' ? 'border-red-200' : 'border-line'
          }`}
        >
          <div className="flex h-24 items-center justify-center bg-surface">
            {a.previewUrl ? (
              <img src={a.previewUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <FileText className="size-8 text-faint" aria-hidden />
            )}
            {a.status === 'uploading' && (
              <div className="absolute inset-x-0 top-0 flex h-24 items-center justify-center bg-white/60">
                <Loader2 className="size-5 animate-spin text-brand-600" aria-label="Uploading" />
              </div>
            )}
          </div>
          <div className="px-2 py-1.5">
            <p className="truncate font-medium text-ink" title={a.file.name}>
              {a.file.name}
            </p>
            {a.status === 'error' ? (
              <p className="flex items-center gap-1 text-red-600">
                <AlertCircle className="size-3 shrink-0" aria-hidden />
                <span className="truncate" title={a.error}>
                  {a.error}
                </span>
              </p>
            ) : (
              <p className="text-muted">
                {a.status === 'uploading' ? `Uploading ${Math.round(a.progress * 100)}%` : formatBytes(a.file.size)}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={`Remove ${a.file.name}`}
            onClick={() => onRemove(a.localId)}
            className="absolute top-1 right-1 rounded-full bg-white/90 p-0.5 text-muted shadow-sm hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

import { Upload } from 'lucide-react';
import { useRef } from 'react';

/** Text-link style trigger ("⤒ Upload List" in Figma) around a hidden file input. */
export function FileUpload({
  label = 'Upload List',
  accept = '.csv,.txt,text/csv,text/plain',
  onFile,
  disabled,
}: {
  label?: string;
  accept?: string;
  onFile: (file: File) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-600 disabled:opacity-50"
      >
        <Upload className="size-4" aria-hidden />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const base =
  'rounded-md bg-surface px-3 text-sm text-ink placeholder:text-faint outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-brand-500 aria-invalid:ring-red-400';

/** Full width unless the caller passes its own width (e.g. `w-20`). */
const width = (className: string) => (/(^|\s)w-/.test(className) ? '' : 'w-full');

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  return <input ref={ref} className={`${base} ${width(className)} h-9 ${className}`} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} className={`${base} ${width(className)} py-2 ${className}`} {...rest} />;
});

/** Figma "form row": label on the left, control on the right. */
export function FieldRow({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-3 sm:grid-cols-[96px_1fr]">
      <label htmlFor={htmlFor} className="pt-2 text-sm text-muted">
        {label}
      </label>
      <div>
        {children}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

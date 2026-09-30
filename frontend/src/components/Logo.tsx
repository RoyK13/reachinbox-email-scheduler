/** Pixel-font wordmark, as in the Figma sidebar. */
export function Logo({ className = '' }: { className?: string }) {
  return <span className={`font-pixel text-2xl font-bold tracking-tight text-ink ${className}`}>ONB</span>;
}

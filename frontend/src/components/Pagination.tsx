import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatNumber } from '../utils/format';
import { IconButton } from './ui/Button';

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-3 text-xs text-muted">
      <span>
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </span>
      <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <IconButton label="Next page" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}

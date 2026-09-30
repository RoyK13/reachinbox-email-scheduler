import Papa from 'papaparse';

// Pragmatic address check (same shape the backend's validator accepts).
const EMAIL_RE = /^[^\s@"'<>(),;:\\[\]]+@[^\s@"'<>(),;:\\[\]]+\.[a-z]{2,}$/i;
const EMAIL_HEADER_RE = /^(e-?mail|email[\s_-]?address|mail)$/i;

export interface ParsedLeads {
  emails: string[];
  /** Non-empty values that were not valid addresses. */
  invalid: number;
  /** Valid addresses dropped because they appeared earlier in the file. */
  duplicates: number;
  /** Which column was used (CSV with a header), if any. */
  column: string | null;
}

export function normalizeEmail(value: string): string {
  return value.trim().replace(/^mailto:/i, '').replace(/^["'<]+|[>"']+$/g, '').toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value) && value.length <= 254;
}

function collect(values: string[], column: string | null): ParsedLeads {
  const seen = new Set<string>();
  const emails: string[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const raw of values) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    if (!isValidEmail(email)) {
      invalid++;
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    emails.push(email);
  }
  return { emails, invalid, duplicates, column };
}

/**
 * CSV: if a header row names an email column ("email", "Email Address", …) only
 * that column is read; otherwise every cell containing "@" is considered.
 * TXT: one address per line (commas/semicolons also accepted as separators).
 */
export function parseLeadsText(text: string, fileName = ''): ParsedLeads {
  const isCsv = /\.csv$/i.test(fileName) || (!/\.txt$/i.test(fileName) && text.includes(','));
  if (!isCsv) {
    return collect(text.split(/[\r\n,;]+/), null);
  }

  const { data } = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  const rows = data.filter((r) => Array.isArray(r) && r.length > 0);
  if (rows.length === 0) return collect([], null);

  const header = rows[0] ?? [];
  const emailCol = header.findIndex((h) => EMAIL_HEADER_RE.test(String(h).trim()));
  if (emailCol >= 0) {
    return collect(
      rows.slice(1).map((r) => String(r[emailCol] ?? '')),
      String(header[emailCol]).trim(),
    );
  }

  // No recognizable header: take any cell that looks like it holds an address.
  const cells = rows.flatMap((r) => r.map((c) => String(c ?? ''))).filter((c) => c.includes('@'));
  return collect(cells, null);
}

export async function parseLeadsFile(file: File): Promise<ParsedLeads> {
  if (file.size > 20 * 1024 * 1024) throw new Error('File is larger than 20 MB');
  if (!/\.(csv|txt)$/i.test(file.name) && !/^text\//.test(file.type)) {
    throw new Error('Please upload a .csv or .txt file');
  }
  return parseLeadsText(await file.text(), file.name);
}

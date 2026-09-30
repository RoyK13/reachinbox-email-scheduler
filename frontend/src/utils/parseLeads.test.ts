import { describe, expect, it } from 'vitest';
import { parseLeadsText } from './parseLeads';

describe('parseLeadsText', () => {
  it('reads a CSV with a single "email" column', () => {
    const res = parseLeadsText('email\njohn@example.com\nalice@example.com\n', 'leads.csv');
    expect(res).toEqual({ emails: ['john@example.com', 'alice@example.com'], invalid: 0, duplicates: 0, column: 'email' });
  });

  it('detects the email column among others', () => {
    const csv = 'name,Email Address,company\nJohn,JOHN@Example.com ,Acme\nAlice,alice@example.com,Globex\n';
    const res = parseLeadsText(csv, 'leads.csv');
    expect(res.emails).toEqual(['john@example.com', 'alice@example.com']);
    expect(res.column).toBe('Email Address');
  });

  it('handles quoted fields containing commas', () => {
    const csv = 'name,email\n"Smith, John",john@example.com\n';
    expect(parseLeadsText(csv, 'x.csv').emails).toEqual(['john@example.com']);
  });

  it('falls back to scanning cells when there is no email header', () => {
    const csv = 'John,john@example.com\nAlice,alice@example.com\n';
    expect(parseLeadsText(csv, 'x.csv').emails).toEqual(['john@example.com', 'alice@example.com']);
  });

  it('reads a TXT file with one address per line', () => {
    const res = parseLeadsText('john@example.com\r\nalice@example.com\n\nbob@example.com\n', 'list.txt');
    expect(res.emails).toEqual(['john@example.com', 'alice@example.com', 'bob@example.com']);
  });

  it('counts invalid and duplicate entries', () => {
    const res = parseLeadsText('email\na@x.com\nnot-an-email\nA@X.com\n\nb@x.com\n', 'x.csv');
    expect(res).toMatchObject({ emails: ['a@x.com', 'b@x.com'], invalid: 1, duplicates: 1 });
  });

  it('strips a UTF-8 BOM and mailto: prefixes', () => {
    const res = parseLeadsText('﻿email\nmailto:c@x.com\n', 'x.csv');
    expect(res.emails).toEqual(['c@x.com']);
  });
});

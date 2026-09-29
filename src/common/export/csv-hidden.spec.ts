import { describe, expect, it } from 'vitest';
import { csvRow, type CsvColumn } from './csv';
import { HIDDEN } from '../security/mask-by-shape';

/**
 * A value the reader's role hides is `[hidden]` in a file — decided by what a
 * column READ, so a column that combines or transforms values can never turn
 * the marker into a confident wrong answer (D-82).
 */

type Row = {
  id: string;
  email?: unknown;
  verified?: unknown;
  tags?: unknown;
  first?: unknown;
  last?: unknown;
  referrer?: unknown;
  createdAt?: Date;
};

const columns: CsvColumn<Row>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'Email', value: (r) => r.email as string },
  // The trap: HIDDEN is truthy, so without the read-tracking this says "yes".
  { header: 'Verified', value: (r) => (r.verified ? 'yes' : 'no') },
  { header: 'Tags', value: (r) => (r.tags as { label: string }[]).map((t) => t.label).join(', ') },
  { header: 'Name', value: (r) => `${r.first as string} ${r.last as string}` },
  { header: 'Introducer', value: (r) => (r.referrer as { name: string }).name },
  { header: 'Created', value: (r) => r.createdAt },
];

const cells = (line: string) => line.trimEnd().split(',');

describe('csvRow — a hidden value is [hidden], never blank and never guessed', () => {
  it('prints every hidden cell as [hidden] — direct, transformed, joined, combined, nested', () => {
    const line = csvRow(columns, {
      id: 'r1',
      email: HIDDEN,
      verified: HIDDEN,
      tags: HIDDEN,
      first: 'Layla',
      last: HIDDEN,
      referrer: { name: HIDDEN },
      createdAt: new Date('2026-09-29T10:00:00Z'),
    });
    expect(cells(line)).toEqual([
      'r1',
      '[hidden]',
      '[hidden]',
      '[hidden]',
      '[hidden]',
      '[hidden]',
      '2026-09-29T10:00:00.000Z',
    ]);
  });

  it('leaves an empty value empty and a visible one as it is', () => {
    const line = csvRow(columns, {
      id: 'r2',
      email: null,
      verified: false,
      tags: [{ label: 'VIP' }],
      first: 'Omar',
      last: 'Saleh',
      referrer: { name: 'Nour' },
      createdAt: new Date('2026-09-29T10:00:00Z'),
    });
    expect(cells(line)).toEqual([
      'r2',
      '',
      'no',
      'VIP',
      'Omar Saleh',
      'Nour',
      '2026-09-29T10:00:00.000Z',
    ]);
  });

  it('hides a tag list whose ELEMENTS were hidden', () => {
    const line = csvRow(columns, { id: 'r3', tags: [{ label: HIDDEN }], referrer: { name: 'N' } });
    expect(cells(line)[3]).toBe('[hidden]');
  });
});

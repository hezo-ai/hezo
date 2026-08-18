import { expect, test } from 'vitest';
import { csvColumnCount, isCsvAssetPath, parseCsvPreview, sniffDelimiter } from '../src/lib/csv';

// The CSV parser behind the asset viewer's table rendering: RFC 4180 quoting,
// delimiter sniffing, and the row cap that keeps a large export from being laid
// out in full.

test('parses quoted fields carrying the delimiter, newlines and escaped quotes', () => {
	const content = [
		'url,reply_text,priority',
		'https://x.com/a/1,"Orchestration, memory, and a ""living"" summary.",high',
		'https://x.com/b/2,"Two lines',
		'in one cell",low',
	].join('\n');

	const { delimiter, rows, truncated } = parseCsvPreview(content);

	expect(delimiter).toBe(',');
	expect(truncated).toBe(false);
	expect(rows).toEqual([
		['url', 'reply_text', 'priority'],
		['https://x.com/a/1', 'Orchestration, memory, and a "living" summary.', 'high'],
		['https://x.com/b/2', 'Two lines\nin one cell', 'low'],
	]);
});

test('handles CRLF endings, a trailing newline, blank lines and a BOM', () => {
	const { rows } = parseCsvPreview('﻿a,b\r\n1,2\r\n\r\n3,4\r\n');
	expect(rows).toEqual([
		['a', 'b'],
		['1', '2'],
		['3', '4'],
	]);
});

test('sniffs semicolon and tab separated files, defaulting to comma', () => {
	expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
	expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
	// Commas inside quoted cells do not make a semicolon file comma-separated.
	expect(sniffDelimiter('a;b\n"x, y";2')).toBe(';');
	// Nothing splits this into columns - the caller falls back to plain text.
	expect(sniffDelimiter('just one column\nof lines')).toBe(',');
});

test('a single-column file parses to one cell per row', () => {
	const { rows } = parseCsvPreview('alpha\nbravo');
	expect(rows).toEqual([['alpha'], ['bravo']]);
	expect(csvColumnCount(rows)).toBe(1);
});

test('caps the parsed rows and reports that more remain', () => {
	const lines = ['a,b', ...Array.from({ length: 20 }, (_, i) => `${i},row`)];
	const capped = parseCsvPreview(lines.join('\n'), 5);
	expect(capped.rows.length).toBe(5);
	expect(capped.truncated).toBe(true);

	// A file that ends exactly at the cap (trailing newline included) is not
	// reported as truncated.
	const exact = parseCsvPreview('a,b\n1,2\n', 2);
	expect(exact.rows.length).toBe(2);
	expect(exact.truncated).toBe(false);
});

test('ragged rows keep their own cell counts; the widest sets the column count', () => {
	const { rows } = parseCsvPreview('a,b,c\n1,2\n3,4,5,6');
	expect(rows).toEqual([
		['a', 'b', 'c'],
		['1', '2'],
		['3', '4', '5', '6'],
	]);
	expect(csvColumnCount(rows)).toBe(4);
});

test('empty content parses to no rows', () => {
	expect(parseCsvPreview('').rows).toEqual([]);
	expect(parseCsvPreview('\n\n').rows).toEqual([]);
});

test('recognises a .csv path regardless of case or folder', () => {
	expect(isCsvAssetPath('x-replies/x-replies-2026-08-18.csv')).toBe(true);
	expect(isCsvAssetPath('REPORT.CSV')).toBe(true);
	expect(isCsvAssetPath('notes.txt')).toBe(false);
	expect(isCsvAssetPath('csv')).toBe(false);
});

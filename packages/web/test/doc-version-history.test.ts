import { describe, expect, test } from 'vitest';
import type { DocumentRevision } from '../src/components/revisions-panel';
import { buildDocVersionHistory, type DocVersionHead } from '../src/lib/doc-version-history';

function rev(partial: Partial<DocumentRevision> & { revision_number: number }): DocumentRevision {
	return {
		id: `r${partial.revision_number}`,
		content: `content-${partial.revision_number}`,
		change_summary: '',
		author_name: null,
		created_at: '2026-01-01T00:00:00Z',
		...partial,
	};
}

describe('buildDocVersionHistory', () => {
	test('pairs each version with the changelog that produced it (one-step shift)', () => {
		const head: DocVersionHead = {
			content: 'V4',
			created_at: 't0',
			updated_at: 't4',
			last_updated_by_name: 'ml',
			last_updated_by_type: 'agent',
		};
		// Newest-first, as the API returns. A row's change_summary is the update that
		// REPLACED that row's content.
		const revisions: DocumentRevision[] = [
			rev({
				revision_number: 3,
				content: 'V3',
				change_summary: 'produced V4',
				author_name: 'ml',
				author_type: 'agent',
				created_at: 't4',
			}),
			rev({
				revision_number: 2,
				content: 'V2',
				change_summary: 'produced V3',
				author_name: 'sd',
				author_type: 'agent',
				created_at: 't3',
			}),
			rev({
				revision_number: 1,
				content: 'V1',
				change_summary: 'produced V2',
				author_name: 'sd',
				author_type: 'agent',
				created_at: 't2',
			}),
		];

		const entries = buildDocVersionHistory(head, revisions);
		expect(entries).toHaveLength(4);

		// Current head: its changelog is the newest revision's summary.
		expect(entries[0]).toMatchObject({
			isCurrent: true,
			content: 'V4',
			changelog: 'produced V4',
			authorName: 'ml',
			timestamp: 't4',
			isInitial: false,
		});
		expect(entries[0].restoreRevisionNumber).toBeUndefined();

		// Past version V3 (from row rev=3), produced by the update recorded on rev=2.
		expect(entries[1]).toMatchObject({
			revisionNumber: 3,
			content: 'V3',
			changelog: 'produced V3',
			authorName: 'sd',
			timestamp: 't3',
			restoreRevisionNumber: 3,
			isInitial: false,
		});

		expect(entries[2]).toMatchObject({
			revisionNumber: 2,
			content: 'V2',
			changelog: 'produced V2',
			restoreRevisionNumber: 2,
		});

		// Oldest version = initial: no changelog, falls back to the doc's created_at.
		expect(entries[3]).toMatchObject({
			revisionNumber: 1,
			content: 'V1',
			changelog: '',
			isInitial: true,
			timestamp: 't0',
			restoreRevisionNumber: 1,
		});
	});

	test('a document with no revisions yields a single initial current version', () => {
		const head: DocVersionHead = {
			content: 'only',
			updated_at: 't1',
			last_updated_by_name: 'alice',
			last_updated_by_type: 'admin',
		};
		const entries = buildDocVersionHistory(head, []);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			isCurrent: true,
			isInitial: true,
			content: 'only',
			changelog: '',
			authorName: 'alice',
		});
	});

	test('a single revision yields current + the initial past version', () => {
		const head: DocVersionHead = {
			content: 'B',
			created_at: 't0',
			updated_at: 't1',
			last_updated_by_name: 'bob',
		};
		const entries = buildDocVersionHistory(head, [
			rev({
				revision_number: 1,
				content: 'A',
				change_summary: 'B replaces A',
				author_name: 'bob',
				created_at: 't1',
			}),
		]);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ isCurrent: true, content: 'B', changelog: 'B replaces A' });
		expect(entries[1]).toMatchObject({
			content: 'A',
			isInitial: true,
			changelog: '',
			restoreRevisionNumber: 1,
		});
	});

	test('tolerates undefined revisions (still returns the current version)', () => {
		const entries = buildDocVersionHistory({ content: 'x', updated_at: 't1' }, undefined);
		expect(entries).toHaveLength(1);
		expect(entries[0].isCurrent).toBe(true);
	});
});

/**
 * One revision row as every revision endpoint returns it — documents (which
 * backs project docs, the project Custom Prompt and agent system prompts) and
 * skills alike. The two tables are shape-compatible: `revision_number`,
 * `content`, `change_summary`, `author_member_id` and `created_at` in both.
 * `author_api_key_id` exists only on `document_revisions`, so it is optional.
 */
export interface RevisionRow {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	author_type?: string;
	author_api_key_id?: string | null;
	created_at: string;
}

/**
 * Builds the version timeline shown in the revision-history dialog.
 *
 * A `document_revisions` row snapshots the doc's *prior* content paired with the
 * `change_summary` of the edit that replaced it — so the changelog on a row
 * describes the update that moved the doc *away* from that row's content, and the
 * current head is never itself a row. To present clean "version + the changelog
 * that produced it" entries we shift by one step:
 *
 *   - current head  → content = doc.content, changelog = newest revision's summary
 *   - each revision → content = that row, changelog = the NEXT-OLDER row's summary
 *   - oldest revision → the initial version (no changelog)
 *
 * Newest-first. `restoreRevisionNumber` is the number to pass to the restore
 * endpoint to bring a past version's content back as the new current version.
 */
export interface DocVersionEntry {
	/** The revision number for a past version; null for the current head. */
	revisionNumber: number | null;
	isCurrent: boolean;
	/** No changelog because it's the document's first version. */
	isInitial: boolean;
	content: string;
	changelog: string;
	authorName: string | null;
	authorType?: string;
	timestamp: string;
	/** Pass to the restore endpoint to make this past version current (absent for the head). */
	restoreRevisionNumber?: number;
}

export interface DocVersionHead {
	content?: string;
	created_at?: string;
	updated_at: string;
	last_updated_by_name?: string | null;
	last_updated_by_type?: string;
}

export function buildDocVersionHistory(
	head: DocVersionHead,
	revisions: RevisionRow[] | undefined,
): DocVersionEntry[] {
	const rows = revisions ?? []; // newest-first, as the API returns them
	const entries: DocVersionEntry[] = [];

	entries.push({
		revisionNumber: null,
		isCurrent: true,
		isInitial: rows.length === 0,
		content: head.content ?? '',
		changelog: rows[0]?.change_summary ?? '',
		authorName: rows[0]?.author_name ?? head.last_updated_by_name ?? null,
		authorType: rows[0]?.author_type ?? head.last_updated_by_type,
		timestamp: head.updated_at,
	});

	for (let i = 0; i < rows.length; i++) {
		const contentRow = rows[i];
		// The edit that PRODUCED contentRow.content is recorded on the next-older row.
		const producedBy = rows[i + 1];
		entries.push({
			revisionNumber: contentRow.revision_number,
			isCurrent: false,
			isInitial: !producedBy,
			content: contentRow.content,
			changelog: producedBy?.change_summary ?? '',
			authorName: producedBy?.author_name ?? null,
			authorType: producedBy?.author_type,
			timestamp: producedBy?.created_at ?? head.created_at ?? contentRow.created_at,
			restoreRevisionNumber: contentRow.revision_number,
		});
	}

	return entries;
}

import { ChatMessageRole, checkInjectedTextCap, InjectedTextCapError } from '@hezo/shared';
import type { Db } from '../db/database';
import { withTransaction } from '../lib/sql';

/**
 * Per-agent long-term chat memory + the byte-window math that drives automatic
 * compaction.
 *
 * Each chat-enabled agent keeps a single markdown `chat_memories` row (no
 * revision history). The active message window — the non-compacted `chat_messages`
 * shown in the chatbox and replayed into each turn — is bounded by a byte cap.
 * When the window exceeds the cap the agent itself summarizes the whole window
 * into its long-term memory; the server then evicts all but the latest few
 * messages (`markCompacted`). The summarization is done by the agent in its
 * container — there is deliberately no server-side LLM call here.
 */

export interface ChatMemory {
	content: string;
	updated_at: string;
}

/** Read an agent's long-term memory, or null when it has none yet. */
export async function getChatMemory(db: Db, memberId: string): Promise<ChatMemory | null> {
	const r = await db.query<ChatMemory>(
		`SELECT content, updated_at FROM chat_memories WHERE member_id = $1`,
		[memberId],
	);
	return r.rows[0] ?? null;
}

export interface ChatMemoryRevision {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	/** Display name of the operator who wrote it; null for automatic compaction. */
	author_name: string | null;
	/** 'admin' when a person wrote it; 'agent' for the agent's own compaction. */
	author_type: string;
	created_at: string;
}

/**
 * Overwrite an agent's long-term memory, snapshotting what it replaced.
 *
 * The write is a full rewrite — the agent hands back the whole revised markdown —
 * and it happens automatically whenever the live message window overflows its cap.
 * A compaction that over-summarises would otherwise destroy standing operator
 * preferences with nothing to roll back to, so each content-changing write records
 * the PRIOR content as a revision, mirroring `document_revisions`.
 *
 * A no-op write records nothing: under MVCC an unchanged UPDATE still leaves a dead
 * tuple, and a revision saying "identical to the one before it" is noise in the
 * history the operator reads.
 */
export async function upsertChatMemory(
	db: Db,
	memberId: string,
	content: string,
	changeSummary?: string,
	authorMemberId?: string | null,
): Promise<ChatMemory> {
	return withTransaction(db, async () => {
		const prior = await db.query<{ content: string }>(
			'SELECT content FROM chat_memories WHERE member_id = $1',
			[memberId],
		);
		const priorContent = prior.rows[0]?.content;

		// Refuse rather than truncate, but refuse in a way that converges: compaction
		// is what drains the message window, so a dead-end refusal would wedge the
		// chat. The error names the ceiling and the current size, so the agent's
		// retry is a shorter rewrite rather than a guess — and passing the prior
		// length keeps an over-ceiling memory shrinkable instead of frozen. Checked
		// inside the transaction because that read is where the prior length comes
		// from; the throw rolls back before anything is written.
		const tooLarge = checkInjectedTextCap('chat_memory', content, priorContent?.length);
		if (tooLarge) throw new InjectedTextCapError(tooLarge.error);

		// A create has nothing to snapshot; only a real change does.
		if (priorContent !== undefined && priorContent !== content) {
			await db.query(
				`INSERT INTO chat_memory_revisions
				        (member_id, revision_number, content, change_summary, author_member_id)
				 SELECT $1,
				        COALESCE(MAX(revision_number), 0) + 1,
				        $2,
				        $3,
				        $4
				 FROM chat_memory_revisions WHERE member_id = $1`,
				[memberId, priorContent, changeSummary ?? '', authorMemberId ?? null],
			);
		}

		const r = await db.query<ChatMemory>(
			`INSERT INTO chat_memories (member_id, content, updated_at)
			 VALUES ($1, $2, now())
			 ON CONFLICT (member_id) DO UPDATE SET content = $2, updated_at = now()
			 RETURNING content, updated_at`,
			[memberId, content],
		);
		return r.rows[0];
	});
}

/** An agent's chat-memory revisions, newest first. */
export async function listChatMemoryRevisions(
	db: Db,
	memberId: string,
): Promise<ChatMemoryRevision[]> {
	const r = await db.query<ChatMemoryRevision>(
		`SELECT r.id, r.revision_number, r.content, r.change_summary, r.created_at,
		        m.display_name AS author_name,
		        CASE WHEN r.author_member_id IS NULL THEN 'agent' ELSE 'admin' END AS author_type
		 FROM chat_memory_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 WHERE r.member_id = $1
		 ORDER BY r.revision_number DESC`,
		[memberId],
	);
	return r.rows;
}

/**
 * Bring a past chat-memory version back as the current one. Append-only: the
 * restore is itself a content change, so the version being replaced is snapshotted
 * too and the timeline stays intact.
 */
export async function restoreChatMemoryRevision(
	db: Db,
	memberId: string,
	revisionNumber: number,
	restoredByMemberId?: string | null,
): Promise<ChatMemory | null> {
	const r = await db.query<{ content: string }>(
		'SELECT content FROM chat_memory_revisions WHERE member_id = $1 AND revision_number = $2',
		[memberId, revisionNumber],
	);
	const target = r.rows[0];
	if (!target) return null;
	return upsertChatMemory(
		db,
		memberId,
		target.content,
		`Restored content from revision ${revisionNumber}`,
		restoredByMemberId ?? null,
	);
}

export interface WindowMessage {
	id: string;
	role: string;
	content: string;
	/**
	 * External sender display label for multi-party (coworker) messages, e.g. the
	 * Slack display name. Null for web/DM messages — the transcript falls back to
	 * the role label ("Operator"/"CEO").
	 */
	authorLabel: string | null;
	/** Library paths of files attached to this message (e.g. `uploads/chat/x.png`). */
	attachmentNames: string[];
}

/**
 * The active (non-compacted) window for a conversation, oldest→newest. Complete
 * messages that carry text OR an attachment count — streaming placeholders and
 * failed turns are neither shown nor replayed, so they shouldn't weigh on the
 * byte budget. Attachment filenames ride along so the prompt can reference the
 * files the operator sent (an attachment-only message has empty content but
 * still belongs in the window).
 */
export async function loadActiveWindow(db: Db, conversationId: string): Promise<WindowMessage[]> {
	const r = await db.query<{
		id: string;
		role: string;
		content: string;
		author_label: string | null;
		attachment_names: string | null;
	}>(
		`SELECT m.id, m.role, m.content, m.author_label,
		        string_agg(a.original_filename, E'\n' ORDER BY ca.created_at)
		          FILTER (WHERE a.id IS NOT NULL) AS attachment_names
		 FROM chat_messages m
		 LEFT JOIN chat_message_attachments ca ON ca.chat_message_id = m.id
		 LEFT JOIN assets a ON a.id = ca.asset_id
		 WHERE m.conversation_id = $1 AND m.compacted_at IS NULL
		   AND m.status = 'complete' AND (m.content <> '' OR ca.chat_message_id IS NOT NULL)
		 GROUP BY m.id, m.role, m.content, m.author_label, m.created_at
		 ORDER BY m.created_at ASC`,
		[conversationId],
	);
	return r.rows.map((row) => ({
		id: row.id,
		role: row.role,
		content: row.content,
		authorLabel: row.author_label,
		attachmentNames: row.attachment_names ? row.attachment_names.split('\n') : [],
	}));
}

/** Display label for a transcript line by message role. */
export function roleLabel(role: string): string {
	if (role === ChatMessageRole.User) return 'Operator';
	if (role === ChatMessageRole.Assistant) return 'CEO';
	return 'System';
}

/**
 * One transcript line for a windowed message, appending a bare-reference list of
 * any attached files (`assets/<library-path>`) so the CEO can open them from the
 * HQ asset library. An attachment-only message (empty text) still gets its files.
 * A message carrying an external sender label (coworker/group turns) is labelled
 * with the sender's name ("Alice: …") instead of the generic role label.
 */
export function chatTranscriptLine(msg: {
	role: string;
	content: string;
	authorLabel?: string | null;
	attachmentNames: string[];
}): string {
	const label = msg.authorLabel?.trim() ? msg.authorLabel.trim() : roleLabel(msg.role);
	const base = `${label}: ${msg.content}`;
	if (msg.attachmentNames.length === 0) return base;
	const refs = `[Attached files: ${msg.attachmentNames.map((n) => `assets/${n}`).join(', ')}]`;
	return msg.content ? `${base}\n${refs}` : `${base}${refs}`;
}

/** Byte budget for the transcript embedded in a converted conversation's task. */
export const CONVERT_TRANSCRIPT_MAX_BYTES = 64 * 1024;

/**
 * Task description for a conversation converted into a task: a short preamble
 * plus the active window's transcript, verbatim. When the transcript exceeds
 * the byte budget the OLDEST lines are dropped (the recent tail is what the
 * task is about) and the truncation is stated, so the CEO never mistakes a
 * partial transcript for the whole conversation. Compacted-away messages are
 * likewise stated rather than silently missing.
 */
export function buildConversationTaskDescription(opts: {
	messages: WindowMessage[];
	compactedCount: number;
}): string {
	const lines = opts.messages.map(chatTranscriptLine);
	let dropped = 0;
	let size = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 2, 0);
	while (dropped < lines.length - 1 && size > CONVERT_TRANSCRIPT_MAX_BYTES) {
		size -= Buffer.byteLength(lines[dropped], 'utf8') + 2;
		dropped += 1;
	}
	const notes: string[] = [
		'This task was created from a CEO chat conversation. Full transcript below.',
	];
	if (opts.compactedCount > 0) {
		notes.push(
			`Note: ${opts.compactedCount} earlier message(s) were compacted into the CEO's long-term memory and are not included.`,
		);
	}
	if (dropped > 0) {
		notes.push(`Note: the ${dropped} oldest message(s) were omitted to fit the transcript here.`);
	}
	return `${notes.join('\n')}\n\n---\n\n${lines.slice(dropped).join('\n\n')}`;
}

/** Mark a set of messages compacted (evicted from the active window). No-op for []. */
export async function markCompacted(db: Db, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await db.query(`UPDATE chat_messages SET compacted_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export interface FlushMessage {
	id: string;
	/** Byte size of the message content (Buffer.byteLength, utf8). */
	bytes: number;
	/** Pre-formatted transcript line, e.g. "Operator: hello". */
	line: string;
}

export interface FlushSelection {
	/** Whether the window's combined content exceeds the byte cap. */
	overCap: boolean;
	/** Messages to evict once the agent has folded the window into memory. */
	evictIds: string[];
	/** The full window transcript (oldest→newest) the agent summarizes. */
	windowTranscript: string;
}

/**
 * Decide a compaction flush over the active window. The cap is a high-water
 * trigger, not a per-message trim: when the combined content exceeds `maxBytes`
 * the agent compacts the *entire* window into long-term memory, and everything
 * except the latest `retain` messages is evicted, resetting the window to that
 * short tail. The latest `retain` are always kept — a single oversized recent
 * message can never empty the window. Pure; the DB read/write live elsewhere.
 */
export function selectFlush(
	messages: FlushMessage[],
	maxBytes: number,
	retain: number,
): FlushSelection {
	const total = messages.reduce((sum, m) => sum + m.bytes, 0);
	const overCap = total > maxBytes;
	const evictCount = Math.max(0, messages.length - Math.max(0, retain));
	const evictIds = messages.slice(0, evictCount).map((m) => m.id);
	const windowTranscript = messages.map((m) => m.line).join('\n\n');
	return { overCap, evictIds, windowTranscript };
}

import type { PGlite } from '@electric-sql/pglite';

/**
 * Per-agent long-term chat memory + the byte-window math that drives automatic
 * compaction.
 *
 * Each chat-enabled agent keeps a single markdown `chat_memories` row (no
 * revision history). The active message window — the non-compacted `ceo_messages`
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
export async function getChatMemory(db: PGlite, memberId: string): Promise<ChatMemory | null> {
	const r = await db.query<ChatMemory>(
		`SELECT content, updated_at FROM chat_memories WHERE member_id = $1`,
		[memberId],
	);
	return r.rows[0] ?? null;
}

/** Overwrite an agent's long-term memory (full rewrite; no revision history). */
export async function upsertChatMemory(
	db: PGlite,
	memberId: string,
	content: string,
): Promise<ChatMemory> {
	const r = await db.query<ChatMemory>(
		`INSERT INTO chat_memories (member_id, content, updated_at)
		 VALUES ($1, $2, now())
		 ON CONFLICT (member_id) DO UPDATE SET content = $2, updated_at = now()
		 RETURNING content, updated_at`,
		[memberId, content],
	);
	return r.rows[0];
}

export interface WindowMessage {
	id: string;
	role: string;
	content: string;
}

/**
 * The active (non-compacted) window for a conversation, oldest→newest. Only
 * complete, non-empty messages count — streaming placeholders and failed turns
 * are neither shown nor replayed, so they shouldn't weigh on the byte budget.
 */
export async function loadActiveWindow(
	db: PGlite,
	conversationId: string,
): Promise<WindowMessage[]> {
	const r = await db.query<WindowMessage>(
		`SELECT id, role, content FROM ceo_messages
		 WHERE conversation_id = $1 AND compacted_at IS NULL
		   AND status = 'complete' AND content <> ''
		 ORDER BY created_at ASC`,
		[conversationId],
	);
	return r.rows;
}

/** Mark a set of messages compacted (evicted from the active window). No-op for []. */
export async function markCompacted(db: PGlite, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await db.query(`UPDATE ceo_messages SET compacted_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
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

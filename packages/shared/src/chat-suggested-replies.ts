/**
 * The suggested-quick-replies trailer an agent reply may end with:
 *
 *     [[suggest: first option | second option | third option]]
 *
 * Parsed once, at message-complete, on the server; the options are stored on
 * the message (`chat_messages.suggested_replies`) and the trailer is stripped
 * from the body, so a client never sees the wire form. Lives in the shared
 * package because the limits are a contract between the parser and the chips
 * the web renders, and a drifted copy of either would show options the other
 * refused.
 */

/** At most this many chips per reply; extras invalidate the trailer. */
export const SUGGESTED_REPLIES_MAX = 3;

/**
 * Longest option, in characters. A chip is a one-tap message, not a paragraph;
 * anything longer is judged malformed and the trailer is dropped whole.
 */
export const SUGGESTED_REPLY_MAX_LENGTH = 80;

const TRAILER_RE = /\n?\s*\[\[suggest:([^\]]*)\]\]\s*$/;

export interface ParsedSuggestedReplies {
	/** The reply body with the trailer stripped (trailing whitespace trimmed). */
	body: string;
	/** The validated options, or null when no valid trailer was present. */
	replies: string[] | null;
}

/**
 * Split a completed reply into its clean body and its suggested replies.
 *
 * An invalid trailer - empty, too many options, an over-long or empty option -
 * is stripped from the body but yields no replies: the agent misused the form,
 * and rendering half a malformed offer is worse than rendering none. A body
 * with no trailer at all comes back untouched.
 */
export function parseSuggestedReplies(content: string): ParsedSuggestedReplies {
	const match = content.match(TRAILER_RE);
	if (!match) return { body: content, replies: null };
	const body = content.slice(0, match.index).replace(/\s+$/, '');
	const options = match[1]
		.split('|')
		.map((option) => option.trim())
		.filter((option) => option.length > 0);
	const valid =
		options.length > 0 &&
		options.length <= SUGGESTED_REPLIES_MAX &&
		options.every((option) => option.length <= SUGGESTED_REPLY_MAX_LENGTH);
	return { body, replies: valid ? options : null };
}

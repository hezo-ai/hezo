import type { PGlite } from '@electric-sql/pglite';
import {
	ADMIN_MENTION_SLUG,
	agentPath,
	assetPath,
	CeoChannel,
	commentPath,
	extractMentionCandidates,
	GLOBAL_INBOX_PATH,
	projectDocPath,
	SKILLS_SETTINGS_PATH,
	taskPath,
	transformMentionsOutsideCode,
} from '@hezo/shared';
import { getInstanceBaseUrl } from '../lib/system-meta';
import { resolveInstanceMentions } from './instance-mentions';

/**
 * Renders a stored CEO message (canonical bare-reference markdown, per
 * agents/_partials/common/linking-syntax.md) for a delivery channel. Stored
 * `ceo_messages.content` is NEVER rewritten — rendering happens at the
 * consumption edge, so each channel decides how references appear:
 *
 * - `web`      → returned unchanged. The web client resolves references itself
 *               and renders them as client-side router links.
 * - `telegram` → instance-unique references become standard markdown links
 *               `[ref](<base URL><entity path>)` using the instance base URL
 *               from global settings. NOTE for the future bot transport:
 *               Telegram parse modes are MarkdownV2/HTML and MarkdownV2
 *               requires escaping `_*[]()~\`>#+-=|{}.!` outside entities —
 *               this module emits plain CommonMark; conversion/escaping is the
 *               transport layer's job.
 * - `whatsapp` → returned unchanged (plain-text policy: no links injected).
 *
 * Fallbacks: base URL unset → unchanged; unknown or instance-ambiguous
 * references stay bare text; references inside code fences and inline code are
 * never touched.
 */
export async function renderCeoMessageForChannel(
	db: PGlite,
	content: string,
	channel: CeoChannel,
): Promise<string> {
	if (channel !== CeoChannel.Telegram) return content;

	const baseUrl = await getInstanceBaseUrl(db);
	if (!baseUrl) return content;

	const resolved = await resolveInstanceMentions(db, extractMentionCandidates(content));
	const tasks = new Map(resolved.tasks.map((t) => [t.identifier.toLowerCase(), t]));
	const docs = new Map(resolved.project_docs.map((d) => [d.filename, d]));
	const kbDocs = new Map(resolved.kb_docs.map((k) => [k.slug.toLowerCase(), k]));
	const assets = new Map(resolved.assets.map((a) => [a.filename, a]));
	const agents = new Map(resolved.agents.map((a) => [a.slug.toLowerCase(), a]));

	return transformMentionsOutsideCode(content, (token) => {
		switch (token.kind) {
			case 'task': {
				const t = tasks.get(token.identifier);
				return t ? `[${token.raw}](${baseUrl}${taskPath(t.project_slug, token.identifier)})` : null;
			}
			case 'comment': {
				const t = tasks.get(token.taskIdentifier);
				return t
					? `[${token.raw}](${baseUrl}${commentPath(t.project_slug, token.taskIdentifier, token.commentId)})`
					: null;
			}
			case 'filename': {
				const d = docs.get(token.filename);
				if (d) {
					return `[${token.raw}](${baseUrl}${projectDocPath(d.project_slug, token.filename)})`;
				}
				const kb = kbDocs.get(token.filename.toLowerCase());
				if (kb) {
					const slugParam = `slug=${encodeURIComponent(kb.slug.toLowerCase())}`;
					return `[${token.raw}](${baseUrl}${SKILLS_SETTINGS_PATH}?${slugParam})`;
				}
				return null;
			}
			case 'asset': {
				const a = assets.get(token.filename);
				return a ? `[${token.raw}](${baseUrl}${assetPath(a.project_slug, token.filename)})` : null;
			}
			case 'agent':
			case 'passive_agent': {
				// Passive `@@slug` displays as the bare slug (no prefix), matching the
				// web renderer; active `@slug` keeps its prefix.
				const display = token.kind === 'passive_agent' ? token.raw.slice(2) : token.raw;
				if (token.slug === ADMIN_MENTION_SLUG) {
					return `[${display}](${baseUrl}${GLOBAL_INBOX_PATH})`;
				}
				const a = agents.get(token.slug);
				if (a) return `[${display}](${baseUrl}${agentPath(a.project_slug, token.slug)})`;
				// An unresolved passive `@@slug` still sheds its `@@` authoring prefix and
				// renders as the bare slug — the double-@ is internal syntax that must
				// never surface. Active `@slug` keeps its (readable) prefix as plain text.
				return token.kind === 'passive_agent' ? display : null;
			}
		}
	});
}

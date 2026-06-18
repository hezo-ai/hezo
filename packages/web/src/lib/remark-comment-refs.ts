import { commentPath } from '@hezo/shared';

/**
 * The task an agent run is working on. A run's prose references comments on this
 * task by their bare `public_id` (the creation-timestamp slug), so the formatted
 * log view links those references back to the comment in this task's thread.
 */
export interface CommentRefTask {
	/** Project-scoped task identifier (e.g. `TO-7`); lowercased when linked. */
	identifier: string;
	title: string;
	projectSlug: string;
}

interface TextNode {
	type: 'text';
	value: string;
}

interface InlineCodeNode {
	type: 'inlineCode';
	value: string;
}

interface LinkNode {
	type: 'link';
	url: string;
	title?: string | null;
	children: TextNode[];
	data?: { hProperties?: Record<string, string> };
}

interface ParentNode {
	type: string;
	children?: MdNode[];
	value?: string;
}

type MdNode = ParentNode | TextNode | InlineCodeNode | LinkNode;

// A comment's public_id is its creation timestamp `YYYYMMDDHHMMSS` (UTC) with an
// optional `-N` suffix for same-second collisions on a task. Bare in prose, the
// lookbehind/lookaround keep it from matching inside a longer number or a
// hyphenated token (mirrors the shared mention regexes).
const PUBLIC_ID_RE = /(?<![\w-])(\d{14}(?:-\d+)?)(?![\w-])/g;

/**
 * True when `value` is shape-valid as a comment public_id: 14 digits that parse
 * as a plausible UTC timestamp, plus an optional `-N` disambiguation suffix.
 * The timestamp sanity check is what keeps an arbitrary 14-digit number (an
 * order id, a hash) from being mistaken for a comment reference.
 */
export function isCommentPublicId(value: string): boolean {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(value);
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	if (year < 2000 || year > 2099) return false;
	if (month < 1 || month > 12) return false;
	if (day < 1 || day > 31) return false;
	if (hour > 23 || minute > 59 || second > 59) return false;
	return true;
}

function commentLink(publicId: string, task: CommentRefTask): LinkNode {
	const identifier = task.identifier.toLowerCase();
	return {
		type: 'link',
		url: commentPath(task.projectSlug, identifier, publicId),
		children: [{ type: 'text', value: publicId }],
		// Same data attributes the @mention comment link emits, so the markdown
		// renderer's existing `a` override turns it into an in-app, scroll-to-comment
		// link (see CommentRefLink).
		data: {
			hProperties: {
				'data-mention-comment-task-identifier': identifier,
				'data-mention-comment-id': publicId,
				'data-mention-comment-project-slug': task.projectSlug,
				'data-mention-comment-task-title': task.title,
			},
		},
	};
}

/** Split a text node on every valid public_id, linking each occurrence. */
function splitText(value: string, task: CommentRefTask): MdNode[] {
	const parts: MdNode[] = [];
	let lastIndex = 0;
	const re = new RegExp(PUBLIC_ID_RE.source, 'g');
	let match = re.exec(value);
	while (match !== null) {
		const candidate = match[1];
		if (isCommentPublicId(candidate)) {
			if (match.index > lastIndex) {
				parts.push({ type: 'text', value: value.slice(lastIndex, match.index) });
			}
			parts.push(commentLink(candidate, task));
			lastIndex = match.index + match[0].length;
		}
		match = re.exec(value);
	}
	if (parts.length === 0) return [{ type: 'text', value }];
	if (lastIndex < value.length) parts.push({ type: 'text', value: value.slice(lastIndex) });
	return parts;
}

/**
 * When an inline-code span is *exactly* a public_id (optionally wrapped in
 * quotes, as agents habitually write `"<public_id>"`), link it. Anything else
 * inside backticks stays literal code — only a whole-span id is rewritten, so
 * real code like `npm install` is never touched.
 */
function inlineCodeLink(value: string, task: CommentRefTask): LinkNode | null {
	let inner = value.trim();
	if (
		(inner.startsWith('"') && inner.endsWith('"')) ||
		(inner.startsWith("'") && inner.endsWith("'"))
	) {
		inner = inner.slice(1, -1).trim();
	}
	return isCommentPublicId(inner) ? commentLink(inner, task) : null;
}

// Fenced code blocks and existing links are left untouched.
const SKIP_TYPES = new Set(['code', 'link']);

function walk(parent: ParentNode, task: CommentRefTask) {
	const children = parent.children;
	if (!children) return;
	const next: MdNode[] = [];
	for (const child of children) {
		if (child.type === 'text' && typeof (child as TextNode).value === 'string') {
			next.push(...splitText((child as TextNode).value, task));
			continue;
		}
		if (child.type === 'inlineCode' && typeof (child as InlineCodeNode).value === 'string') {
			const link = inlineCodeLink((child as InlineCodeNode).value, task);
			next.push(link ?? child);
			continue;
		}
		if (SKIP_TYPES.has(child.type)) {
			next.push(child);
			continue;
		}
		if ((child as ParentNode).children) walk(child as ParentNode, task);
		next.push(child);
	}
	parent.children = next;
}

/**
 * Remark plugin (scoped to the agent-run formatted log view) that turns bare
 * and inline-code comment public_ids in the run's prose into links to that
 * comment in the run's task. Unlike the @mention pipeline — which deliberately
 * leaves inline code literal — this view is a read-only render of an agent's
 * reasoning, where a timestamp-shaped id is overwhelmingly a comment reference,
 * so we link it even when the agent wrapped it in backticks.
 */
export function remarkCommentRefs(task: CommentRefTask) {
	return (tree: ParentNode) => {
		walk(tree, task);
	};
}

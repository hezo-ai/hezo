import {
	ADMIN_MENTION_SLUG,
	agentPath,
	assetPath,
	buildMentionRegex,
	commentPath,
	GLOBAL_INBOX_PATH,
	type MentionToken,
	parseMentionMatch,
	projectDocPath,
	projectInboxPath,
	SKILLS_SETTINGS_PATH,
	taskPath,
} from '@hezo/shared';

// Candidate extraction lives in @hezo/shared (the server-side renderer uses it
// too); re-exported here so web consumers keep a single import path.
export { type DocCandidates, extractDocCandidates, extractTaskCandidates } from '@hezo/shared';

interface TextNode {
	type: 'text';
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

type MdNode = ParentNode | TextNode | LinkNode;

export interface AgentMentionData {
	title: string;
	/** Set in instance scope: the agent's home project (HQ agents → `hq`). */
	projectSlug?: string;
}

export interface TaskMentionData {
	title: string;
	projectSlug: string;
}

export interface KbDocMentionData {
	title: string;
	size: number;
	updatedAt: string;
}

export interface ProjectDocMentionData {
	size: number;
	updatedAt: string;
}

export type ProjectDocsMap = Map<string, Map<string, ProjectDocMentionData>>;

export interface AssetMentionData {
	id: string;
	signedUrl: string;
	/** Set in instance scope: the project the asset belongs to. */
	projectSlug?: string;
}

interface Options {
	/**
	 * Project scope: links resolve against this project (agents, admin inbox,
	 * KB). Instance scope (the global CEO chat) omits it and sets `instance` —
	 * every link then derives its project from the per-entity resolution data.
	 */
	projectId?: string;
	projectSlug?: string;
	instance?: boolean;
	agents: Map<string, AgentMentionData>;
	tasks: Map<string, TaskMentionData>;
	kbDocs: Map<string, KbDocMentionData>;
	projectDocs: ProjectDocsMap;
	assets: Map<string, AssetMentionData>;
}

const MENTION_RE = buildMentionRegex();

const SKIP_TYPES = new Set(['code', 'inlineCode', 'link']);

export function remarkMentions(opts: Options) {
	return (tree: ParentNode) => {
		walk(tree, opts);
	};
}

function walk(parent: ParentNode, opts: Options) {
	const children = parent.children;
	if (!children) return;
	const next: MdNode[] = [];
	for (const child of children) {
		if (child.type === 'text' && typeof (child as TextNode).value === 'string') {
			next.push(...splitTextNode(child as TextNode, opts));
			continue;
		}
		// Chat (instance) scope only: a backticked doc/asset reference still links —
		// see linkifyInlineCodeDoc. Every other surface keeps inline code inert, so
		// this runs before the SKIP_TYPES guard below.
		if (
			opts.instance &&
			child.type === 'inlineCode' &&
			typeof (child as TextNode).value === 'string'
		) {
			const link = linkifyInlineCodeDoc(child as TextNode, opts);
			next.push(link ?? child);
			continue;
		}
		if (SKIP_TYPES.has(child.type)) {
			next.push(child);
			continue;
		}
		if ((child as ParentNode).children) {
			walk(child as ParentNode, opts);
		}
		next.push(child);
	}
	parent.children = next;
}

function splitTextNode(node: TextNode, opts: Options): MdNode[] {
	const value = node.value;
	const parts: MdNode[] = [];
	let lastIndex = 0;
	MENTION_RE.lastIndex = 0;
	let match = MENTION_RE.exec(value);
	while (match !== null) {
		const token = parseMentionMatch(match);
		const link = buildLink(token, opts);
		// A passive `@@slug` that can't resolve to a link (unknown agent, or an agent
		// slug that's ambiguous instance-wide — every Startup team has a `captain`)
		// still strips its `@@` authoring prefix and degrades to the bare slug as
		// plain text. The double-@ is internal mention syntax and must never surface
		// to a reader, matching how the resolved passive form already drops it.
		const replacement: MdNode | null =
			link ?? (token.kind === 'passive_agent' ? { type: 'text', value: token.raw.slice(2) } : null);
		if (!replacement) {
			match = MENTION_RE.exec(value);
			continue;
		}
		const start = match.index;
		const end = start + match[0].length;
		if (start > lastIndex) {
			parts.push({ type: 'text', value: value.slice(lastIndex, start) });
		}
		parts.push(replacement);
		lastIndex = end;
		match = MENTION_RE.exec(value);
	}
	if (parts.length === 0) return [node];
	if (lastIndex < value.length) {
		parts.push({ type: 'text', value: value.slice(lastIndex) });
	}
	return parts;
}

/**
 * Chat scope only: an inline-code span whose *entire* content is a project-doc
 * filename or an `assets/<file>` reference is linkified exactly like the bare
 * form (so docs/assets open in a new tab). CEO replies are LLM-authored and
 * habitually wrap filenames in backticks, so the "write entities bare" rule the
 * composer enforces for human authors can't apply to this surface — linking them
 * anyway keeps the references clickable. Tasks, @-mentions, and anything that
 * isn't a resolvable doc/asset stay inert code, preserving the convention
 * everywhere it still matters; a span that merely *contains* a filename
 * (`see prd.md below`) is left as code, since the whole span must be the
 * reference. Returns null to keep the original inline-code node.
 */
function linkifyInlineCodeDoc(node: TextNode, opts: Options): LinkNode | null {
	const value = node.value.trim();
	if (!value) return null;
	MENTION_RE.lastIndex = 0;
	const match = MENTION_RE.exec(value);
	if (!match || match.index !== 0 || match[0].length !== value.length) return null;
	const token = parseMentionMatch(match);
	if (token.kind !== 'filename' && token.kind !== 'asset') return null;
	return buildLink(token, opts);
}

function buildLink(token: MentionToken, opts: Options): LinkNode | null {
	const { projectId, projectSlug, agents, tasks, kbDocs, assets } = opts;
	const display = token.raw;

	if (token.kind === 'asset') {
		const data = assets.get(token.filename);
		if (!data) return null;
		const slug = (data.projectSlug ?? projectSlug)?.toLowerCase();
		if (!slug) return null;
		return {
			type: 'link',
			url: assetPath(slug, token.filename),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-asset-project-slug': slug,
					'data-mention-asset-filename': token.filename,
					'data-mention-asset-url': data.signedUrl,
				},
			},
		};
	}

	if (token.kind === 'passive_agent') {
		// `@@slug` renders as the bare slug (no prefix) — passive references stay
		// visually distinct from an active `@slug` ask, which keeps its prefix.
		const passiveDisplay = display.slice(2);
		if (token.slug === ADMIN_MENTION_SLUG) {
			return {
				type: 'link',
				url: projectId ? projectInboxPath(projectId) : GLOBAL_INBOX_PATH,
				children: [{ type: 'text', value: passiveDisplay }],
				data: {
					hProperties: {
						'data-mention-admin': 'true',
						'data-mention-passive': 'true',
					},
				},
			};
		}
		const data = agents.get(token.slug);
		if (!data) return null;
		const agentProject = data.projectSlug ?? projectId;
		if (!agentProject) return null;
		return {
			type: 'link',
			url: agentPath(agentProject, token.slug),
			children: [{ type: 'text', value: passiveDisplay }],
			data: {
				hProperties: {
					'data-mention-agent-slug': token.slug,
					'data-mention-agent-title': data.title,
					'data-mention-agent-project-slug': agentProject,
					'data-mention-passive': 'true',
				},
			},
		};
	}

	if (token.kind === 'agent') {
		if (token.slug === ADMIN_MENTION_SLUG) {
			return {
				type: 'link',
				url: projectId ? projectInboxPath(projectId) : GLOBAL_INBOX_PATH,
				children: [{ type: 'text', value: display }],
				data: {
					hProperties: {
						'data-mention-admin': 'true',
					},
				},
			};
		}
		const data = agents.get(token.slug);
		if (!data) return null;
		const agentProject = data.projectSlug ?? projectId;
		if (!agentProject) return null;
		return {
			type: 'link',
			url: agentPath(agentProject, token.slug),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-agent-slug': token.slug,
					'data-mention-agent-title': data.title,
					'data-mention-agent-project-slug': agentProject,
				},
			},
		};
	}

	if (token.kind === 'comment') {
		const data = tasks.get(token.taskIdentifier);
		if (!data) return null;
		return {
			type: 'link',
			url: commentPath(data.projectSlug, token.taskIdentifier, token.commentId),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-comment-task-identifier': token.taskIdentifier,
					'data-mention-comment-id': token.commentId,
					'data-mention-comment-project-slug': data.projectSlug,
					'data-mention-comment-task-title': data.title,
				},
			},
		};
	}

	if (token.kind === 'task') {
		const data = tasks.get(token.identifier);
		if (!data) return null;
		return {
			type: 'link',
			url: taskPath(data.projectSlug, token.identifier),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-task-identifier': token.identifier,
					'data-mention-task-title': data.title,
					'data-mention-project-slug': data.projectSlug,
				},
			},
		};
	}

	if (token.kind === 'filename') {
		const docHit = findProjectDoc(token.filename, opts);
		if (docHit) {
			return {
				type: 'link',
				url: projectDocPath(docHit.projectSlug, token.filename),
				children: [{ type: 'text', value: display }],
				data: {
					hProperties: {
						'data-mention-doc-project-slug': docHit.projectSlug,
						'data-mention-doc-filename': token.filename,
						'data-mention-size': String(docHit.data.size),
						'data-mention-updated-at': docHit.data.updatedAt,
					},
				},
			};
		}

		const kbKey = token.filename.toLowerCase();
		const kbData = kbDocs.get(kbKey);
		if (kbData) {
			const slugParam = `slug=${encodeURIComponent(kbKey)}`;
			return {
				type: 'link',
				url: projectId
					? `/projects/${projectId}/skills?${slugParam}`
					: `${SKILLS_SETTINGS_PATH}?${slugParam}`,
				children: [{ type: 'text', value: display }],
				data: {
					hProperties: {
						'data-mention-kb-slug': kbKey,
						'data-mention-kb-title': kbData.title,
						'data-mention-size': String(kbData.size),
						'data-mention-updated-at': kbData.updatedAt,
					},
				},
			};
		}
	}

	return null;
}

function findProjectDoc(
	filename: string,
	opts: Options,
): { projectSlug: string; data: ProjectDocMentionData } | null {
	if (opts.projectSlug) {
		const slug = opts.projectSlug.toLowerCase();
		const data = opts.projectDocs.get(slug)?.get(filename);
		return data ? { projectSlug: slug, data } : null;
	}
	if (opts.instance) {
		// Instance scope: the resolver returns a filename only when exactly one
		// project has it, so the first per-project hit is the only one.
		for (const [slug, perProject] of opts.projectDocs) {
			const data = perProject.get(filename);
			if (data) return { projectSlug: slug, data };
		}
	}
	return null;
}

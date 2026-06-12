import {
	ADMIN_MENTION_SLUG,
	agentPath,
	assetPath,
	buildMentionRegex,
	commentPath,
	type MentionToken,
	parseMentionMatch,
	projectDocPath,
	projectInboxPath,
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
	contentType: string;
	signedUrl: string;
}

interface Options {
	projectId: string;
	projectSlug?: string;
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
		const link = buildLink(parseMentionMatch(match), opts);
		if (!link) {
			match = MENTION_RE.exec(value);
			continue;
		}
		const start = match.index;
		const end = start + match[0].length;
		if (start > lastIndex) {
			parts.push({ type: 'text', value: value.slice(lastIndex, start) });
		}
		parts.push(link);
		lastIndex = end;
		match = MENTION_RE.exec(value);
	}
	if (parts.length === 0) return [node];
	if (lastIndex < value.length) {
		parts.push({ type: 'text', value: value.slice(lastIndex) });
	}
	return parts;
}

function buildLink(token: MentionToken, opts: Options): LinkNode | null {
	const { projectId, projectSlug, agents, tasks, kbDocs, projectDocs, assets } = opts;
	const display = token.raw;

	if (token.kind === 'asset') {
		if (!projectSlug) return null;
		const slug = projectSlug.toLowerCase();
		const data = assets.get(token.filename);
		if (!data) return null;
		return {
			type: 'link',
			url: assetPath(slug, token.filename),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-asset-project-slug': slug,
					'data-mention-asset-filename': token.filename,
					'data-mention-asset-content-type': data.contentType,
					'data-mention-asset-url': data.signedUrl,
				},
			},
		};
	}

	if (token.kind === 'passive_agent') {
		// `@@slug` renders as `@slug` — passive mentions display like active ones.
		const passiveDisplay = display.slice(1);
		if (token.slug === ADMIN_MENTION_SLUG) {
			return {
				type: 'link',
				url: projectInboxPath(projectId),
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
		return {
			type: 'link',
			url: agentPath(projectId, token.slug),
			children: [{ type: 'text', value: passiveDisplay }],
			data: {
				hProperties: {
					'data-mention-agent-slug': token.slug,
					'data-mention-agent-title': data.title,
					'data-mention-passive': 'true',
				},
			},
		};
	}

	if (token.kind === 'agent') {
		if (token.slug === ADMIN_MENTION_SLUG) {
			return {
				type: 'link',
				url: projectInboxPath(projectId),
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
		return {
			type: 'link',
			url: agentPath(projectId, token.slug),
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-agent-slug': token.slug,
					'data-mention-agent-title': data.title,
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
		if (projectSlug) {
			const slug = projectSlug.toLowerCase();
			const perProject = projectDocs.get(slug);
			const data = perProject?.get(token.filename);
			if (data) {
				return {
					type: 'link',
					url: projectDocPath(slug, token.filename),
					children: [{ type: 'text', value: display }],
					data: {
						hProperties: {
							'data-mention-doc-project-slug': slug,
							'data-mention-doc-filename': token.filename,
							'data-mention-size': String(data.size),
							'data-mention-updated-at': data.updatedAt,
						},
					},
				};
			}
		}

		const kbKey = token.filename.toLowerCase();
		const kbData = kbDocs.get(kbKey);
		if (kbData) {
			return {
				type: 'link',
				url: `/projects/${projectId}/skills?slug=${encodeURIComponent(kbKey)}`,
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

import { BOARD_MENTION_SLUG } from '@hezo/shared';

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
	teamId: string;
	projectSlug?: string;
	agents: Map<string, AgentMentionData>;
	tasks: Map<string, TaskMentionData>;
	kbDocs: Map<string, KbDocMentionData>;
	projectDocs: ProjectDocsMap;
	assets: Map<string, AssetMentionData>;
}

const PASSIVE_AGENT_RE_SRC = String.raw`(?<![\w@])@@([a-z][\w-]*)(?![\w/])`;
const AGENT_RE_SRC = String.raw`(?<![\w@])@([a-z][\w-]*)(?![\w/])`;
const TASK_RE_SRC = String.raw`(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])`;
const FILENAME_RE_SRC = String.raw`(?<![\w/.-])([a-z0-9][\w-]*\.[a-z0-9]+)(?![\w/.-])`;
// Asset references are path-prefixed (`assets/<name>.<ext>`) and may contain
// uppercase (e.g. a task identifier embedded in the name). The leading `assets/`
// keeps them from colliding with the bare project-doc filenames above.
const ASSET_RE_SRC = String.raw`(?<![\w/.-])assets/([A-Za-z0-9][\w.-]*\.[A-Za-z0-9]+)(?![\w/.-])`;

const MENTION_RE = new RegExp(
	`${PASSIVE_AGENT_RE_SRC}|${AGENT_RE_SRC}|${TASK_RE_SRC}|${FILENAME_RE_SRC}|${ASSET_RE_SRC}`,
	'g',
);

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
		const link = buildLink(match, opts);
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

function buildLink(match: RegExpExecArray, opts: Options): LinkNode | null {
	const { teamId, projectSlug, agents, tasks, kbDocs, projectDocs, assets } = opts;
	const display = match[0];
	const passiveAgentToken = match[1];
	const agentToken = match[2];
	const taskToken = match[3];
	const filenameToken = match[4];
	const assetToken = match[5];

	if (assetToken) {
		if (!projectSlug) return null;
		const slug = projectSlug.toLowerCase();
		const data = assets.get(assetToken);
		if (!data) return null;
		return {
			type: 'link',
			url: `/teams/${teamId}/projects/${slug}/assets?file=${encodeURIComponent(assetToken)}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-asset-project-slug': slug,
					'data-mention-asset-filename': assetToken,
					'data-mention-asset-content-type': data.contentType,
					'data-mention-asset-url': data.signedUrl,
				},
			},
		};
	}

	if (passiveAgentToken) {
		const slug = passiveAgentToken.toLowerCase();
		if (slug === BOARD_MENTION_SLUG) {
			return {
				type: 'link',
				url: `/teams/${teamId}/inbox`,
				children: [{ type: 'text', value: `@${passiveAgentToken}` }],
				data: {
					hProperties: {
						'data-mention-board': 'true',
						'data-mention-passive': 'true',
					},
				},
			};
		}
		const data = agents.get(slug);
		if (!data) return null;
		return {
			type: 'link',
			url: `/teams/${teamId}/agents/${slug}`,
			children: [{ type: 'text', value: `@${passiveAgentToken}` }],
			data: {
				hProperties: {
					'data-mention-agent-slug': slug,
					'data-mention-agent-title': data.title,
					'data-mention-passive': 'true',
				},
			},
		};
	}

	if (agentToken) {
		const slug = agentToken.toLowerCase();
		if (slug === BOARD_MENTION_SLUG) {
			return {
				type: 'link',
				url: `/teams/${teamId}/inbox`,
				children: [{ type: 'text', value: display }],
				data: {
					hProperties: {
						'data-mention-board': 'true',
					},
				},
			};
		}
		const data = agents.get(slug);
		if (!data) return null;
		return {
			type: 'link',
			url: `/teams/${teamId}/agents/${slug}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-agent-slug': slug,
					'data-mention-agent-title': data.title,
				},
			},
		};
	}

	if (taskToken) {
		const key = taskToken.toLowerCase();
		const data = tasks.get(key);
		if (!data) return null;
		return {
			type: 'link',
			url: `/teams/${teamId}/projects/${data.projectSlug}/tasks/${key}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-task-identifier': key,
					'data-mention-task-title': data.title,
					'data-mention-project-slug': data.projectSlug,
				},
			},
		};
	}

	if (filenameToken) {
		if (projectSlug) {
			const slug = projectSlug.toLowerCase();
			const perProject = projectDocs.get(slug);
			const data = perProject?.get(filenameToken);
			if (data) {
				return {
					type: 'link',
					url: `/teams/${teamId}/projects/${slug}/documents?file=${encodeURIComponent(filenameToken)}`,
					children: [{ type: 'text', value: display }],
					data: {
						hProperties: {
							'data-mention-doc-project-slug': slug,
							'data-mention-doc-filename': filenameToken,
							'data-mention-size': String(data.size),
							'data-mention-updated-at': data.updatedAt,
						},
					},
				};
			}
		}

		const kbKey = filenameToken.toLowerCase();
		const kbData = kbDocs.get(kbKey);
		if (kbData) {
			return {
				type: 'link',
				url: `/teams/${teamId}/skills?slug=${encodeURIComponent(kbKey)}`,
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

export function extractTaskCandidates(value: string): string[] {
	const stripped = stripCode(value);
	const re = new RegExp(TASK_RE_SRC, 'g');
	const out = new Set<string>();
	let m = re.exec(stripped);
	while (m !== null) {
		out.add(m[1].toLowerCase());
		m = re.exec(stripped);
	}
	return Array.from(out);
}

export interface DocCandidates {
	kbSlugs: string[];
	projectDocs: Array<{ project_slug: string; filename: string }>;
	assets: Array<{ project_slug: string; filename: string }>;
}

export function extractDocCandidates(value: string, projectSlug?: string): DocCandidates {
	const stripped = stripCode(value);
	const filenameSet = new Set<string>();

	const re = new RegExp(FILENAME_RE_SRC, 'g');
	let m = re.exec(stripped);
	while (m !== null) {
		filenameSet.add(m[1]);
		m = re.exec(stripped);
	}

	const assetSet = new Set<string>();
	const assetRe = new RegExp(ASSET_RE_SRC, 'g');
	let am = assetRe.exec(stripped);
	while (am !== null) {
		assetSet.add(am[1]);
		am = assetRe.exec(stripped);
	}

	const kbSlugs = Array.from(filenameSet, (f) => f.toLowerCase());
	const projectDocs: Array<{ project_slug: string; filename: string }> = [];
	const assets: Array<{ project_slug: string; filename: string }> = [];
	if (projectSlug) {
		const slug = projectSlug.toLowerCase();
		for (const filename of filenameSet) {
			projectDocs.push({ project_slug: slug, filename });
		}
		for (const filename of assetSet) {
			assets.push({ project_slug: slug, filename });
		}
	}

	return { kbSlugs, projectDocs, assets };
}

function stripCode(value: string): string {
	return value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`]*`/g, ' ');
}

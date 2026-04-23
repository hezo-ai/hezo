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

export interface IssueMentionData {
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

interface Options {
	companyId: string;
	projectSlug?: string;
	agents: Map<string, AgentMentionData>;
	issues: Map<string, IssueMentionData>;
	kbDocs: Map<string, KbDocMentionData>;
	projectDocs: ProjectDocsMap;
}

const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*(?:\/[a-z0-9][\w.-]*)*)/gi;
const ISSUE_SHAPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*-\d+$/i;

const SKIP_TYPES = new Set(['code', 'inlineCode']);

export function remarkMentions(opts: Options) {
	return (tree: ParentNode) => {
		if (
			opts.agents.size === 0 &&
			opts.issues.size === 0 &&
			opts.kbDocs.size === 0 &&
			opts.projectDocs.size === 0
		)
			return;
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
		const token = match[1].toLowerCase();
		const link = buildLink(token, match[0], opts);
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

function buildLink(token: string, display: string, opts: Options): LinkNode | null {
	const { companyId, projectSlug, agents, issues, kbDocs, projectDocs } = opts;

	if (token.startsWith('kb/')) {
		const slug = token.slice(3);
		if (!slug || slug.includes('/')) return null;
		const data = kbDocs.get(slug);
		if (!data) return null;
		return {
			type: 'link',
			url: `/companies/${companyId}/kb?slug=${encodeURIComponent(slug)}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-kb-slug': slug,
					'data-mention-kb-title': data.title,
					'data-mention-size': String(data.size),
					'data-mention-updated-at': data.updatedAt,
				},
			},
		};
	}

	if (token.startsWith('doc/')) {
		const rest = token.slice(4);
		if (!rest) return null;
		const segments = rest.split('/');
		let docProjectSlug: string | null = null;
		let filename: string | null = null;
		if (segments.length === 1) {
			if (!projectSlug) return null;
			docProjectSlug = projectSlug.toLowerCase();
			filename = segments[0];
		} else if (segments.length === 2) {
			docProjectSlug = segments[0];
			filename = segments[1];
		} else {
			return null;
		}
		const perProject = projectDocs.get(docProjectSlug);
		if (!perProject) return null;
		const data = perProject.get(filename);
		if (!data) return null;
		return {
			type: 'link',
			url: `/companies/${companyId}/projects/${docProjectSlug}/documents?file=${encodeURIComponent(filename)}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-doc-project-slug': docProjectSlug,
					'data-mention-doc-filename': filename,
					'data-mention-size': String(data.size),
					'data-mention-updated-at': data.updatedAt,
				},
			},
		};
	}

	if (ISSUE_SHAPE_RE.test(token) && issues.has(token)) {
		const data = issues.get(token) as IssueMentionData;
		return {
			type: 'link',
			url: `/companies/${companyId}/projects/${data.projectSlug}/issues/${token}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-issue-identifier': token,
					'data-mention-issue-title': data.title,
					'data-mention-project-slug': data.projectSlug,
				},
			},
		};
	}

	if (agents.has(token)) {
		const data = agents.get(token) as AgentMentionData;
		return {
			type: 'link',
			url: `/companies/${companyId}/agents/${token}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-agent-slug': token,
					'data-mention-agent-title': data.title,
				},
			},
		};
	}

	return null;
}

export function extractIssueCandidates(value: string): string[] {
	const stripped = stripCode(value);
	const re = /(?<![\w@])@([a-z0-9][\w-]*-\d+)(?![\w/-])/gi;
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
}

export function extractDocCandidates(value: string, projectSlug?: string): DocCandidates {
	const stripped = stripCode(value);
	const kbSet = new Set<string>();
	const docMap = new Map<string, { project_slug: string; filename: string }>();
	MENTION_RE.lastIndex = 0;
	let m = MENTION_RE.exec(stripped);
	while (m !== null) {
		const token = m[1].toLowerCase();
		if (token.startsWith('kb/')) {
			const slug = token.slice(3);
			if (slug && !slug.includes('/')) kbSet.add(slug);
		} else if (token.startsWith('doc/')) {
			const rest = token.slice(4);
			if (rest) {
				const segs = rest.split('/');
				let p: string | null = null;
				let f: string | null = null;
				if (segs.length === 1) {
					if (projectSlug) {
						p = projectSlug.toLowerCase();
						f = segs[0];
					}
				} else if (segs.length === 2) {
					p = segs[0];
					f = segs[1];
				}
				if (p && f) {
					const key = `${p}/${f}`;
					if (!docMap.has(key)) docMap.set(key, { project_slug: p, filename: f });
				}
			}
		}
		m = MENTION_RE.exec(stripped);
	}
	return { kbSlugs: Array.from(kbSet), projectDocs: Array.from(docMap.values()) };
}

function stripCode(value: string): string {
	return value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`]*`/g, ' ');
}

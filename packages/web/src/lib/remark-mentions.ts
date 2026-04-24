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

const AGENT_RE_SRC = String.raw`(?<![\w@])@([a-z][\w-]*)(?![\w/])`;
const ISSUE_RE_SRC = String.raw`(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])`;
const PROJECT_DOC_RE_SRC = String.raw`(?<![\w/.-])([a-z0-9][\w-]*\.[a-z0-9]+)(?![\w/.-])`;
const KB_DOC_RE_SRC = String.raw`(?<![\w/.-])([a-z][a-z0-9-]{2,})(?![\w/.-])`;

const MENTION_RE = new RegExp(
	`${AGENT_RE_SRC}|${ISSUE_RE_SRC}|${PROJECT_DOC_RE_SRC}|${KB_DOC_RE_SRC}`,
	'g',
);

const SKIP_TYPES = new Set(['code', 'inlineCode', 'link']);

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
	const { companyId, projectSlug, agents, issues, kbDocs, projectDocs } = opts;
	const display = match[0];
	const agentToken = match[1];
	const issueToken = match[2];
	const projectDocToken = match[3];
	const kbDocToken = match[4];

	if (agentToken) {
		const slug = agentToken.toLowerCase();
		const data = agents.get(slug);
		if (!data) return null;
		return {
			type: 'link',
			url: `/companies/${companyId}/agents/${slug}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-agent-slug': slug,
					'data-mention-agent-title': data.title,
				},
			},
		};
	}

	if (issueToken) {
		const key = issueToken.toLowerCase();
		const data = issues.get(key);
		if (!data) return null;
		return {
			type: 'link',
			url: `/companies/${companyId}/projects/${data.projectSlug}/issues/${key}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-issue-identifier': key,
					'data-mention-issue-title': data.title,
					'data-mention-project-slug': data.projectSlug,
				},
			},
		};
	}

	if (projectDocToken) {
		if (!projectSlug) return null;
		const slug = projectSlug.toLowerCase();
		const perProject = projectDocs.get(slug);
		if (!perProject) return null;
		const data = perProject.get(projectDocToken);
		if (!data) return null;
		return {
			type: 'link',
			url: `/companies/${companyId}/projects/${slug}/documents?file=${encodeURIComponent(projectDocToken)}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-doc-project-slug': slug,
					'data-mention-doc-filename': projectDocToken,
					'data-mention-size': String(data.size),
					'data-mention-updated-at': data.updatedAt,
				},
			},
		};
	}

	if (kbDocToken) {
		const slug = kbDocToken.toLowerCase();
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

	return null;
}

export function extractIssueCandidates(value: string): string[] {
	const stripped = stripCode(value);
	const re = new RegExp(ISSUE_RE_SRC, 'g');
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
	const docSet = new Set<string>();

	const kbRe = new RegExp(KB_DOC_RE_SRC, 'g');
	let k = kbRe.exec(stripped);
	while (k !== null) {
		kbSet.add(k[1].toLowerCase());
		k = kbRe.exec(stripped);
	}

	const docRe = new RegExp(PROJECT_DOC_RE_SRC, 'g');
	let d = docRe.exec(stripped);
	while (d !== null) {
		docSet.add(d[1]);
		d = docRe.exec(stripped);
	}

	const projectDocs: Array<{ project_slug: string; filename: string }> = [];
	if (projectSlug) {
		const slug = projectSlug.toLowerCase();
		for (const filename of docSet) {
			projectDocs.push({ project_slug: slug, filename });
		}
	}

	return { kbSlugs: Array.from(kbSet), projectDocs };
}

function stripCode(value: string): string {
	return value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`]*`/g, ' ');
}

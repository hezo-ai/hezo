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

interface Options {
	companyId: string;
	agents: Map<string, AgentMentionData>;
	issues: Map<string, IssueMentionData>;
}

const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;
const ISSUE_SHAPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*-\d+$/i;

const SKIP_TYPES = new Set(['code', 'inlineCode']);

export function remarkMentions({ companyId, agents, issues }: Options) {
	return (tree: ParentNode) => {
		if (agents.size === 0 && issues.size === 0) return;
		walk(tree, companyId, agents, issues);
	};
}

function walk(
	parent: ParentNode,
	companyId: string,
	agents: Map<string, AgentMentionData>,
	issues: Map<string, IssueMentionData>,
) {
	const children = parent.children;
	if (!children) return;
	const next: MdNode[] = [];
	for (const child of children) {
		if (child.type === 'text' && typeof (child as TextNode).value === 'string') {
			next.push(...splitTextNode(child as TextNode, companyId, agents, issues));
			continue;
		}
		if (SKIP_TYPES.has(child.type)) {
			next.push(child);
			continue;
		}
		if ((child as ParentNode).children) {
			walk(child as ParentNode, companyId, agents, issues);
		}
		next.push(child);
	}
	parent.children = next;
}

function splitTextNode(
	node: TextNode,
	companyId: string,
	agents: Map<string, AgentMentionData>,
	issues: Map<string, IssueMentionData>,
): MdNode[] {
	const value = node.value;
	const parts: MdNode[] = [];
	let lastIndex = 0;
	MENTION_RE.lastIndex = 0;
	let match = MENTION_RE.exec(value);
	while (match !== null) {
		const slug = match[1].toLowerCase();
		const link = buildLink(slug, match[0], companyId, agents, issues);
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

function buildLink(
	slug: string,
	display: string,
	companyId: string,
	agents: Map<string, AgentMentionData>,
	issues: Map<string, IssueMentionData>,
): LinkNode | null {
	if (ISSUE_SHAPE_RE.test(slug) && issues.has(slug)) {
		const data = issues.get(slug) as IssueMentionData;
		return {
			type: 'link',
			url: `/companies/${companyId}/projects/${data.projectSlug}/issues/${slug}`,
			children: [{ type: 'text', value: display }],
			data: {
				hProperties: {
					'data-mention-issue-identifier': slug,
					'data-mention-issue-title': data.title,
					'data-mention-project-slug': data.projectSlug,
				},
			},
		};
	}
	if (agents.has(slug)) {
		const data = agents.get(slug) as AgentMentionData;
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
	return null;
}

export function extractIssueCandidates(value: string): string[] {
	const stripped = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`]*`/g, ' ');
	const re = /(?<![\w@])@([a-z0-9][\w-]*-\d+)/gi;
	const out = new Set<string>();
	let m = re.exec(stripped);
	while (m !== null) {
		out.add(m[1].toLowerCase());
		m = re.exec(stripped);
	}
	return Array.from(out);
}

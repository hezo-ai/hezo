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

interface Options {
	companyId: string;
	agentSlugs: Set<string>;
}

const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;

const SKIP_TYPES = new Set(['code', 'inlineCode']);

export function remarkAgentMentions({ companyId, agentSlugs }: Options) {
	return (tree: ParentNode) => {
		if (agentSlugs.size === 0) return;
		walk(tree, companyId, agentSlugs);
	};
}

function walk(parent: ParentNode, companyId: string, agentSlugs: Set<string>) {
	const children = parent.children;
	if (!children) return;
	const next: MdNode[] = [];
	for (const child of children) {
		if (child.type === 'text' && typeof (child as TextNode).value === 'string') {
			next.push(...splitTextNode(child as TextNode, companyId, agentSlugs));
			continue;
		}
		if (SKIP_TYPES.has(child.type)) {
			next.push(child);
			continue;
		}
		if ((child as ParentNode).children) {
			walk(child as ParentNode, companyId, agentSlugs);
		}
		next.push(child);
	}
	parent.children = next;
}

function splitTextNode(node: TextNode, companyId: string, agentSlugs: Set<string>): MdNode[] {
	const value = node.value;
	const parts: MdNode[] = [];
	let lastIndex = 0;
	MENTION_RE.lastIndex = 0;
	let match = MENTION_RE.exec(value);
	while (match !== null) {
		const slug = match[1].toLowerCase();
		if (!agentSlugs.has(slug)) {
			match = MENTION_RE.exec(value);
			continue;
		}
		const start = match.index;
		const end = start + match[0].length;
		if (start > lastIndex) {
			parts.push({ type: 'text', value: value.slice(lastIndex, start) });
		}
		const link: LinkNode = {
			type: 'link',
			url: `/companies/${companyId}/agents/${slug}`,
			children: [{ type: 'text', value: `@${slug}` }],
			data: {
				hProperties: { 'data-mention-agent-slug': slug },
			},
		};
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

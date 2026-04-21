const PARTIAL_DIRECTIVE = /^\s*\{\{>\s*partials\/([a-z0-9/_-]+)\s*\}\}\s*$/;
const MAX_DEPTH = 8;
const PARTIAL_PREFIX = '_partials/';

export class PartialResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PartialResolutionError';
	}
}

/**
 * Resolve `{{> partials/<name>}}` includes across role docs.
 *
 * Partials live under `_partials/**\/*.md` and are addressed by path without the
 * prefix or extension (e.g. a file at `_partials/ceo/hire-workflow.md` is
 * referenced as `{{> partials/ceo/hire-workflow}}`).
 *
 * The directive must be the entire line — leading/trailing whitespace is tolerated,
 * but anything else on the line is treated as literal text. Partials can include
 * other partials. Unknown refs and cycles throw.
 */
export function resolvePartials(docs: Record<string, string>): Record<string, string> {
	const partials = new Map<string, string>();
	const roleEntries: [string, string][] = [];

	for (const [path, content] of Object.entries(docs)) {
		if (path.startsWith(PARTIAL_PREFIX)) {
			const name = path.slice(PARTIAL_PREFIX.length).replace(/\.md$/, '');
			partials.set(name, content);
		} else {
			roleEntries.push([path, content]);
		}
	}

	const expanded: Record<string, string> = {};
	for (const [path, content] of roleEntries) {
		expanded[path] = expand(content, partials, new Set(), 0, path);
	}
	return expanded;
}

function expand(
	content: string,
	partials: Map<string, string>,
	visiting: Set<string>,
	depth: number,
	source: string,
): string {
	if (depth > MAX_DEPTH) {
		throw new PartialResolutionError(
			`Partial nesting exceeded ${MAX_DEPTH} levels while resolving ${source}`,
		);
	}

	const lines = content.split('\n');
	const out: string[] = [];
	for (const line of lines) {
		const match = line.match(PARTIAL_DIRECTIVE);
		if (!match) {
			out.push(line);
			continue;
		}
		const name = match[1];
		if (visiting.has(name)) {
			throw new PartialResolutionError(
				`Partial cycle detected: ${[...visiting, name].join(' -> ')}`,
			);
		}
		const body = partials.get(name);
		if (body === undefined) {
			throw new PartialResolutionError(
				`Unknown partial reference '${name}' in ${source}. Add _partials/${name}.md or remove the directive.`,
			);
		}
		const nextVisiting = new Set(visiting);
		nextVisiting.add(name);
		out.push(expand(body, partials, nextVisiting, depth + 1, `partials/${name}`));
	}
	return out.join('\n');
}

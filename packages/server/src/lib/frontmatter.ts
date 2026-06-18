/**
 * Minimal YAML-frontmatter parser for SKILL.md / skill docs.
 *
 * Skill frontmatter is a leading `---` fenced block of top-level `key: value`
 * scalar pairs (`name`, `description`, occasionally `slug`/`metadata`). That is
 * the only shape we need, so this avoids pulling a YAML dependency: it extracts
 * top-level scalar keys and returns the remainder as `body`. Nested/structured
 * YAML (indented children) is ignored rather than mis-parsed.
 */
export function parseFrontmatter(input: string): {
	data: Record<string, string>;
	body: string;
} {
	const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(input);
	if (!match) return { data: {}, body: input };

	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		// Only top-level `key: value` lines (no leading indent → not a nested child).
		const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
		if (!m) continue;
		let value = m[2].trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		data[m[1]] = value;
	}
	return { data, body: input.slice(match[0].length) };
}

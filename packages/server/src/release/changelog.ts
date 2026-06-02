/**
 * Render a categorized Markdown changelog from parsed Conventional Commits.
 * Pure: the date and repo URL are injected so output is deterministic.
 */
import {
	CHANGELOG_BREAKING_HEADING,
	CHANGELOG_OTHER_HEADING,
	CHANGELOG_SECTIONS,
} from '@hezo/shared';
import type { ParsedCommit } from './conventional.js';

export interface RenderChangelogOptions {
	version: string;
	/** ISO date (YYYY-MM-DD) for the release heading. */
	date: string;
	commits: ParsedCommit[];
	/** Previous release tag, or null for the first release. */
	previousTag: string | null;
	/** Repo URL (e.g. https://github.com/owner/repo) for PR/compare links. */
	repoUrl?: string;
}

const KNOWN_TYPES = new Set<string>(CHANGELOG_SECTIONS.map(([type]) => type));

function renderLine(c: ParsedCommit, repoUrl?: string): string {
	const scope = c.scope ? `**${c.scope}:** ` : '';
	let line = `- ${scope}${c.description}`;
	if (c.pr !== null) {
		line += repoUrl ? ` ([#${c.pr}](${repoUrl}/pull/${c.pr}))` : ` (#${c.pr})`;
	}
	return line;
}

function renderSection(heading: string, commits: ParsedCommit[], repoUrl?: string): string {
	if (commits.length === 0) {
		return '';
	}
	const lines = commits.map((c) => renderLine(c, repoUrl));
	return `### ${heading}\n\n${lines.join('\n')}\n`;
}

/** Render the changelog body for a release (used as the GitHub Release body). */
export function renderChangelog(opts: RenderChangelogOptions): string {
	const { version, date, commits, previousTag, repoUrl } = opts;
	const blocks: string[] = [`## ${version} - ${date}\n`];

	const breaking = commits.filter((c) => c.breaking);
	const breakingBlock = renderSection(CHANGELOG_BREAKING_HEADING, breaking, repoUrl);
	if (breakingBlock) {
		blocks.push(breakingBlock);
	}

	for (const [type, heading] of CHANGELOG_SECTIONS) {
		const section = commits.filter((c) => c.type === type);
		const block = renderSection(heading, section, repoUrl);
		if (block) {
			blocks.push(block);
		}
	}

	const other = commits.filter((c) => c.type === '' || !KNOWN_TYPES.has(c.type));
	const otherBlock = renderSection(CHANGELOG_OTHER_HEADING, other, repoUrl);
	if (otherBlock) {
		blocks.push(otherBlock);
	}

	if (repoUrl) {
		const link = previousTag
			? `${repoUrl}/compare/${previousTag}...${version}`
			: `${repoUrl}/commits/${version}`;
		blocks.push(`**Full Changelog**: ${link}`);
	}

	return `${blocks.join('\n').trimEnd()}\n`;
}

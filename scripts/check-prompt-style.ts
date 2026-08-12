// Commit-msg guard: the mechanical half of the agent-prompt writing register.
//
// Sits alongside scripts/check-prompts-ack.ts the way check-docs-links.ts sits
// alongside check-docs-ack.ts: the trailer records the judgement pass, this
// checks what a machine can check. The rules themselves live once in
// `@hezo/shared` (`checkPromptStyle`), shared with the server's authoring
// surfaces and the web UI, so a prompt written at runtime is held to exactly
// the same standard as one committed here.
//
// Severity decides what blocks. `error` findings - a bullet duplicated across
// files, a Hezo-internal symbol in a prompt that ships to other repositories, a
// backticked project-doc filename - fail the commit, because each is
// unambiguous and mechanically detectable. `warning` findings (sentence and
// bullet length, hedges, intensifiers) print but do not block: they are
// judgement calls, and a heuristic that blocks an unrelated commit is how a
// rule ends up being weakened to quiet it. Demote a noisy rule rather than
// adding an exemption.
//
// Pure functions are unit-tested in packages/server/test/prompts-ack-hook.test.ts.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
	checkPromptStyle,
	isComparableBullet,
	normalizeBullet,
	type PromptStyleFinding,
} from '../packages/shared/src/prompt-style';
import { PROMPT_BEARING_PATTERNS } from './check-prompts-ack';

/**
 * A prompt that ships through the marketplace into other people's
 * repositories: a team role doc, or a partial one of them includes. The
 * instance-only surfaces (`_instance/`, `blank/`) stay local, so naming a Hezo
 * path there is merely unhelpful rather than wrong.
 */
export function isMarketplaceReaching(path: string): boolean {
	if (!path.startsWith('agents/')) return false;
	const dir = path.slice('agents/'.length).split('/')[0];
	if (dir === '_instance' || dir === 'blank') return false;
	// A partial can reach a team, so treat every partial as marketplace-reaching.
	return true;
}

/** Files the register applies to, from a list of staged paths. */
export function promptFiles(stagedFiles: string[]): string[] {
	return stagedFiles.filter(
		(f) => f.endsWith('.md') && PROMPT_BEARING_PATTERNS.some((p) => p.test(f)),
	);
}

export interface FileFindings {
	file: string;
	findings: PromptStyleFinding[];
}

/**
 * Bullets that appear, normalized, in more than one file. The second copy is
 * the defect: one of them will be updated and the other will not. Reported
 * against every file carrying it so either can be the one deleted.
 */
export function findCrossFileDuplicates(
	files: { path: string; content: string }[],
): FileFindings[] {
	const seen = new Map<string, { path: string; line: number }[]>();
	for (const { path, content } of files) {
		content.split('\n').forEach((line, i) => {
			if (!/^\s*[-+]\s+/.test(line)) return;
			const norm = normalizeBullet(line);
			if (!isComparableBullet(norm)) return;
			const at = seen.get(norm) ?? [];
			at.push({ path, line: i + 1 });
			seen.set(norm, at);
		});
	}

	const byFile = new Map<string, PromptStyleFinding[]>();
	for (const [norm, places] of seen) {
		const distinct = [...new Set(places.map((p) => p.path))];
		if (distinct.length < 2) continue;
		for (const place of places) {
			const others = distinct.filter((p) => p !== place.path);
			const list = byFile.get(place.path) ?? [];
			list.push({
				rule: 'duplicate_across_files',
				severity: 'error',
				line: place.line,
				excerpt: norm.length <= 80 ? norm : `${norm.slice(0, 77)}...`,
				message: `This bullet also appears in ${others.join(', ')}. State it once, in the highest-reaching surface that covers both - a shared partial, or the shared instructions.`,
			});
			byFile.set(place.path, list);
		}
	}
	return [...byFile].map(([file, findings]) => ({ file, findings }));
}

/** Every finding across the given files, style rules plus cross-file duplication. */
export function checkFiles(files: { path: string; content: string }[]): FileFindings[] {
	const out = new Map<string, PromptStyleFinding[]>();
	for (const { path, content } of files) {
		const findings = checkPromptStyle(content, {
			marketplaceReaching: isMarketplaceReaching(path),
		});
		if (findings.length > 0) out.set(path, findings);
	}
	for (const { file, findings } of findCrossFileDuplicates(files)) {
		out.set(file, [...(out.get(file) ?? []), ...findings]);
	}
	return [...out]
		.map(([file, findings]) => ({ file, findings: findings.sort((a, b) => a.line - b.line) }))
		.sort((a, b) => a.file.localeCompare(b.file));
}

function main(): void {
	const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	const paths = promptFiles(staged);
	if (paths.length === 0) return;

	const files = paths.flatMap((path) => {
		try {
			return [{ path, content: readFileSync(path, 'utf8') }];
		} catch {
			return []; // deleted in this commit
		}
	});

	const results = checkFiles(files);
	const errors = results
		.map((r) => ({ ...r, findings: r.findings.filter((f) => f.severity === 'error') }))
		.filter((r) => r.findings.length > 0);
	const warnings = results
		.map((r) => ({ ...r, findings: r.findings.filter((f) => f.severity === 'warning') }))
		.filter((r) => r.findings.length > 0);

	for (const { file, findings } of warnings) {
		for (const f of findings) {
			console.error(`  ${file}:${f.line}  ${f.message}`);
		}
	}
	if (warnings.length > 0) {
		console.error(
			'\nThe findings above are advisory (see .dev/writing-agent-prompts.md). They do not block this commit.\n',
		);
	}

	if (errors.length === 0) return;

	console.error('\ncommit rejected: agent prompts break the writing register.\n');
	for (const { file, findings } of errors) {
		for (const f of findings) {
			console.error(`  ${file}:${f.line}  [${f.rule}] ${f.message}`);
			console.error(`      ${f.excerpt}`);
		}
	}
	console.error(
		'\nFix these rather than bypassing the hook. The rules are in .dev/writing-agent-prompts.md.\n',
	);
	process.exit(1);
}

if (import.meta.main) main();

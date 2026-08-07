/**
 * Deterministic guard that stops an agent writing a project doc to the
 * container filesystem.
 *
 * Project docs are database records. Every prompt says so - `SHARED_INSTRUCTIONS`
 * opens with it, the docs manifest repeats it naming the Write/Edit tools, and a
 * release shipped for exactly this - and agents still reach for the file tools,
 * because that is what "write the spec" looks like from inside a coding CLI. The
 * failure is silent in the worst way: `Edit` on a path that does not exist
 * errors and the agent recovers, but `Write` SUCCEEDS, so the run believes the
 * doc is saved, the real doc stays stale, and a shadow copy lands in the repo.
 *
 * This is the blocking leg, and it runs on the runtimes that expose a blockable
 * pre-tool hook. The deterministic post-run check in `agent-runner.ts` is the
 * universal leg that catches the rest. Neither replaces prompt guidance; they
 * exist because guidance alone demonstrably does not hold.
 *
 * The guard fails OPEN everywhere: a malformed payload, an unreadable git tree
 * or any thrown error allows the write. A guard that blocks legitimate work
 * would be worse than the problem it solves, and the post-run net still reports
 * anything it lets through.
 */

/**
 * Tool names that write a file by path. `MultiEdit` and `NotebookEdit` are
 * included because they take the same `file_path` and would otherwise be the
 * obvious way around a Write/Edit-only guard.
 */
const GUARDED_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Claude Code matcher expression selecting the tools above. */
export const DOC_WRITE_GUARD_MATCHER = GUARDED_TOOL_NAMES.join('|');

/** Filename the guard script is written under in the per-run home. */
export const DOC_WRITE_GUARD_FILENAME = 'doc-write-guard.mjs';

/**
 * The refusal an agent sees. Names what it tried, why the write would have
 * changed nothing, and the exact call to make instead - a block that does not
 * say what to do instead just gets retried.
 */
function refusalFor(slug: string): string {
	return (
		`'${slug}' is a Hezo project doc, which lives in the database, not on the filesystem. ` +
		`Writing this file would change nothing anyone reads: no teammate, no future run and no ` +
		`web view loads it from disk, and the real doc would stay stale. ` +
		`Use write_project_doc(filename: "${slug}", content: ...) to replace the whole doc, or ` +
		`edit_project_doc(filename: "${slug}", old_string: ..., new_string: ...) to change part of ` +
		`it - edit_project_doc is preferred for an existing doc because it sends only the span you ` +
		`are changing. Read the current text first with read_project_doc.`
	);
}

/** Seconds the guard gets: a string compare plus one `git ls-files`. */
export const DOC_WRITE_GUARD_TIMEOUT_SEC = 10;

/**
 * The Claude-Code-shaped `PreToolUse` hook block pointing at the guard.
 *
 * Shared by the Claude Code adapter (which folds it into `settings.json`) and
 * the Grok adapter (which writes it as its own hooks JSON file - Grok Build
 * reads Claude-Code-shaped hook JSON, and `PreToolUse` is the single event it
 * treats as blocking).
 */
export function buildDocWriteGuardHookBlock(command: string): {
	matcher: string;
	hooks: Array<{ type: 'command'; command: string; timeout: number }>;
} {
	return {
		matcher: DOC_WRITE_GUARD_MATCHER,
		hooks: [{ type: 'command', command, timeout: DOC_WRITE_GUARD_TIMEOUT_SEC }],
	};
}

/**
 * Build the guard script for a run, closed over that project's active doc
 * slugs.
 *
 * Slugs are baked in rather than fetched at hook time so the guard needs no
 * network, no credentials and no Hezo tool access from inside the hook - it is
 * a string comparison and one `git ls-files`.
 */
export function buildDocWriteGuardScript(docSlugs: readonly string[]): string {
	const slugs = JSON.stringify([...new Set(docSlugs.map((s) => s.toLowerCase()))]);
	const refusals = JSON.stringify(
		Object.fromEntries(docSlugs.map((s) => [s.toLowerCase(), refusalFor(s)])),
	);
	return `#!/usr/bin/env node
// Generated per run by Hezo. Blocks a filesystem write aimed at a project doc.
// Fails open on anything unexpected.
//
// This file is ESM (.mjs), so these have to be static imports - \`require\` is
// not defined here, and calling it inside the git check made that check throw,
// which the surrounding catch read as "not tracked" and turned into a block.
// That failed CLOSED on legitimate repo files, the one outcome this guard must
// never produce.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SLUGS = new Set(${slugs});
const REFUSALS = ${refusals};
const GUARDED = new Set(${JSON.stringify([...GUARDED_TOOL_NAMES])});

function allow() { process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (!input || !GUARDED.has(input.tool_name)) return allow();
    const ti = input.tool_input || {};
    const filePath = ti.file_path || ti.path || ti.notebook_path;
    if (typeof filePath !== 'string' || filePath.length === 0) return allow();
    const base = (filePath.split('/').pop() || '').toLowerCase();
    if (!SLUGS.has(base)) return allow();

    // A repo may legitimately track its own file of this name; writing to that
    // is real work and must stay allowed. Only an untracked path is a stray
    // copy of the database doc.
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', filePath], {
        cwd: path.dirname(filePath),
        stdio: 'ignore',
      });
      return allow();
    } catch (_) {
      // Not tracked (or not a git tree at all) - fall through to the refusal.
    }

    const reason = REFUSALS[base];
    if (!reason) return allow();
    // Emit the decision on every channel the CLI may read: structured JSON on
    // stdout, the reason on stderr, and exit 2 as the "intentional block" code.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    process.stderr.write(reason);
    process.exit(2);
  } catch (_) {
    allow();
  }
});
`;
}

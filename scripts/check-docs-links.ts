// Commit-msg guard: a commit staging any docs/**/*.md fails on a broken docs link.
//
// Internal links - docs-to-docs (including #anchors), same-file anchors, relative
// paths, and github.com/hezo-ai/hezo/{blob,raw,tree}/main/<path> links into this
// repo - are checked across the WHOLE tree, not just staged files, because a
// deleted or renamed page breaks other files' links. These checks are
// deterministic and always block.
//
// External URLs are probed only for the staged files (HEAD, then GET on servers
// that refuse HEAD), with successes cached in .git/ for a week. Only a
// definitive 404/410 blocks: a 403 can be a bot wall (console.x.ai answers 403
// to a browser-UA GET while loading fine in a browser), and an offline machine
// must warn, never wedge a commit - which is why there is no bypass env var.
//
// Pure functions here are unit-tested in packages/server/test/docs-links.test.ts,
// which also runs the whole-tree internal check so CI catches what a bypassed
// hook would have.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

const DOCS_DIR = 'docs';
const INTRO_FILE = 'docs/introduction.md';
const SELF_REPO_RE = /^https:\/\/github\.com\/hezo-ai\/hezo\/(?:blob|raw|tree)\/main\/([^#?]+)/;
/** Hosts that appear in docs as examples, never as real destinations. */
const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal', 'example.com']);
/** The only statuses that prove a link wrong; everything else could be the network. */
const HARD_BROKEN_STATUSES = new Set([404, 410]);
const CACHE_PATH = join('.git', 'hezo-docs-link-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 6;
/** Some hosts 403 generic clients; a browser UA keeps false alarms down. */
const LINK_CHECK_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface FoundLink {
	target: string;
	/** 1-based line in the source file. */
	line: number;
}

/**
 * Blank fenced code blocks, preserving line count so reported line numbers stay
 * true. Inline code is left alone here - headings like `## Using \`--foo\``
 * need their backticked text for slugging.
 */
export function stripFences(md: string): string {
	let fence: string | null = null;
	return md
		.split('\n')
		.map((line) => {
			const marker = line.match(/^\s*(```|~~~)/);
			if (fence !== null) {
				if (marker && marker[1] === fence) fence = null;
				return '';
			}
			if (marker) {
				fence = marker[1];
				return '';
			}
			return line;
		})
		.join('\n');
}

/** Blank fenced blocks and inline code spans - example links are not links. */
export function stripCode(md: string): string {
	return stripFences(md)
		.split('\n')
		.map((line) => line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)))
		.join('\n');
}

/** Every inline/image/autolink target with its line number, code stripped. */
export function extractLinks(md: string): FoundLink[] {
	const links: FoundLink[] = [];
	const inline = /!?\[[^\]]*\]\(([^()\s]+(?:\([^()]*\)[^()\s]*)*)\)/g;
	const auto = /<(https?:\/\/[^>\s]+)>/g;
	stripCode(md)
		.split('\n')
		.forEach((line, i) => {
			for (const m of line.matchAll(inline)) links.push({ target: m[1], line: i + 1 });
			for (const m of line.matchAll(auto)) links.push({ target: m[1], line: i + 1 });
		});
	return links;
}

/** GitHub-slugger-compatible anchor for one heading's text. */
export function slugifyHeading(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[*_`]/g, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/** Anchors of every markdown heading, with GitHub's -1/-2 dedup suffixes. */
export function headingAnchors(md: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	for (const m of stripFences(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
		const base = slugifyHeading(m[1]);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		anchors.add(n === 0 ? base : `${base}-${n}`);
	}
	return anchors;
}

/** Map a site-absolute `/docs/...` link to its repo-relative markdown file. */
export function docsPathToFile(sitePath: string): string {
	const sub = sitePath.replace(/^\/docs\/?/, '').replace(/\/$/, '');
	return sub === '' ? INTRO_FILE : posix.join(DOCS_DIR, `${sub}.md`);
}

/** Repo-relative path a github.com/hezo-ai/hezo blob/raw/tree link names, or null. */
export function selfRepoPath(url: string): string | null {
	const m = url.match(SELF_REPO_RE);
	return m ? m[1].replace(/\/$/, '') : null;
}

/** External URLs that are doc examples rather than destinations. */
export function isSkippedExternalUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return SKIP_HOSTS.has(host) || host.endsWith('.example.com');
	} catch {
		return true;
	}
}

export function classifyExternalStatus(status: number): 'ok' | 'broken' | 'unreachable' {
	if (HARD_BROKEN_STATUSES.has(status)) return 'broken';
	if (status >= 200 && status < 400) return 'ok';
	return 'unreachable';
}

/**
 * Validate every internal link in `files` (repo-relative path -> content).
 * `exists` answers for targets outside the map: assets, self-repo file links.
 * Returns one `file:line message` string per problem.
 */
export function checkDocsTree(
	files: Map<string, string>,
	exists: (repoRelativePath: string) => boolean,
): string[] {
	const problems: string[] = [];
	const anchorsByFile = new Map<string, Set<string>>();
	for (const [path, content] of files) anchorsByFile.set(path, headingAnchors(content));

	const checkAnchor = (
		from: string,
		line: number,
		target: string,
		file: string,
		anchor: string,
	) => {
		if (!anchorsByFile.get(file)?.has(anchor)) {
			problems.push(`${from}:${line} broken anchor ${target} (no heading "#${anchor}" in ${file})`);
		}
	};

	for (const [path, content] of files) {
		for (const { target, line } of extractLinks(content)) {
			if (/^https?:\/\//.test(target)) {
				const repoPath = selfRepoPath(target);
				if (repoPath !== null && !exists(repoPath)) {
					problems.push(`${path}:${line} broken repo link ${target} (${repoPath} does not exist)`);
				}
				continue;
			}
			if (target.startsWith('mailto:')) continue;

			const hash = target.indexOf('#');
			const pathPart = hash === -1 ? target : target.slice(0, hash);
			const anchor = hash === -1 ? null : target.slice(hash + 1);

			if (pathPart === '') {
				if (anchor !== null) checkAnchor(path, line, target, path, anchor);
				continue;
			}
			if (pathPart.startsWith('/docs')) {
				const file = docsPathToFile(pathPart);
				if (!files.has(file)) {
					problems.push(`${path}:${line} broken link ${target} (${file} does not exist)`);
					continue;
				}
				if (anchor !== null) checkAnchor(path, line, target, file, anchor);
				continue;
			}
			if (pathPart.startsWith('/')) {
				problems.push(
					`${path}:${line} absolute non-docs link ${target} - use /docs/... or a full URL`,
				);
				continue;
			}
			const resolved = posix.normalize(posix.join(posix.dirname(path), pathPart));
			if (resolved.endsWith('.md') && files.has(resolved)) {
				if (anchor !== null) checkAnchor(path, line, target, resolved, anchor);
				continue;
			}
			if (!exists(resolved)) {
				problems.push(
					`${path}:${line} broken relative link ${target} (${resolved} does not exist)`,
				);
			}
		}
	}
	return problems;
}

export interface ExternalProbe {
	verdict: 'ok' | 'broken' | 'unreachable';
	detail: string;
}

async function fetchStatus(url: string, method: 'HEAD' | 'GET'): Promise<number> {
	const res = await fetch(url, {
		method,
		redirect: 'follow',
		headers: { 'user-agent': LINK_CHECK_UA, accept: '*/*' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	// The status is the answer; never download the body.
	await res.body?.cancel().catch(() => {});
	return res.status;
}

/** HEAD, falling back to GET when the server refuses HEAD or the transport fails. */
export async function probeExternalUrl(url: string): Promise<ExternalProbe> {
	let headStatus: number | null = null;
	try {
		headStatus = await fetchStatus(url, 'HEAD');
		if (classifyExternalStatus(headStatus) === 'ok')
			return { verdict: 'ok', detail: `HEAD ${headStatus}` };
	} catch {
		// fall through to GET
	}
	try {
		const status = await fetchStatus(url, 'GET');
		return { verdict: classifyExternalStatus(status), detail: `GET ${status}` };
	} catch (e) {
		return { verdict: 'unreachable', detail: (e as Error).message };
	}
}

function walkDocsFiles(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const rel = posix.join(dir, entry.name);
			if (entry.isDirectory()) walk(rel);
			else if (entry.name.endsWith('.md')) files.set(rel, readFileSync(join(root, rel), 'utf8'));
		}
	};
	walk(DOCS_DIR);
	return files;
}

function readCache(): Record<string, number> {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, number>;
	} catch {
		return {};
	}
}

function writeCache(cache: Record<string, number>): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify(cache));
	} catch {
		// Cache is an optimization; a worktree layout without .git/ just re-probes.
	}
}

async function main(): Promise<void> {
	const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	const stagedDocs = staged.filter((f) => /^docs\/.*\.md$/.test(f));
	if (stagedDocs.length === 0) return;

	const files = walkDocsFiles(process.cwd());
	const problems = checkDocsTree(files, (p) => existsSync(join(process.cwd(), p)));
	if (problems.length > 0) {
		console.error(`\ncommit rejected: ${problems.length} broken docs link(s):\n`);
		for (const p of problems) console.error(`  ${p}`);
		console.error(
			'\nFix the link or its target. Internal links are checked across the whole docs tree,',
		);
		console.error('so a renamed or deleted page must take its inbound links with it.\n');
		process.exit(1);
	}

	// External URLs: staged files only, successes cached for a week.
	const cache = readCache();
	const now = Date.now();
	const urls = new Map<string, string>();
	for (const f of stagedDocs) {
		const content = files.get(f);
		if (!content) continue; // staged deletion
		for (const { target, line } of extractLinks(content)) {
			if (!/^https?:\/\//.test(target)) continue;
			if (isSkippedExternalUrl(target) || selfRepoPath(target) !== null) continue;
			if (now - (cache[target] ?? 0) < CACHE_TTL_MS) continue;
			if (!urls.has(target)) urls.set(target, `${f}:${line}`);
		}
	}

	const queue = [...urls.entries()];
	const broken: string[] = [];
	const warnings: string[] = [];
	await Promise.all(
		Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
				const [url, where] = item;
				const probe = await probeExternalUrl(url);
				if (probe.verdict === 'ok') cache[url] = now;
				else if (probe.verdict === 'broken') broken.push(`  ${where} ${url} (${probe.detail})`);
				else warnings.push(`  ${where} ${url} (${probe.detail})`);
			}
		}),
	);
	writeCache(cache);

	for (const w of warnings) {
		console.error(`warn: could not verify external link (not blocking):\n${w}`);
	}
	if (broken.length > 0) {
		console.error(`\ncommit rejected: ${broken.length} dead external link(s):\n`);
		for (const b of broken) console.error(b);
		console.error('\nA 404/410 means the URL is wrong or gone - fix or remove the link.\n');
		process.exit(1);
	}
}

if (import.meta.main) {
	main().catch((e) => {
		// The guard must never invent a failure of its own - report and pass.
		console.error(`warn: check-docs-links failed to run (not blocking): ${(e as Error).message}`);
	});
}

import { createHash } from 'node:crypto';
import { decrypt, encrypt } from '../crypto/encryption';
import type { Db } from '../db/database';
import { parseFrontmatter } from '../lib/frontmatter';
import { deriveSkillSummary } from '../lib/skill-summary';
import { toSlug } from '../lib/slug';
import { deleteSystemMeta, getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { downloadSkillContent, SkillDownloadError } from './skill-downloader';
import { recordSkillRevisionIfChanged } from './skill-revisions';

// The skills.sh registry (https://skills.sh) is a public, GitHub-backed catalog
// of agent skills. Its REST API requires a bearer token, so the admin-facing
// "search and add" UI uses a stored token; agents bypass all of this and use the
// `npx skills` CLI directly inside the container.

const REGISTRY_TOKEN_KEY = 'skills_registry_token';
const DEFAULT_BASE_URL = 'https://skills.sh';
const FETCH_TIMEOUT_MS = 10_000;
const SKILL_ID_RE = /^[\w.-]+\/[\w.-]+\/[\w.-]+$/;

function baseUrl(): string {
	return (process.env.SKILLS_REGISTRY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export interface RegistrySearchHit {
	id: string;
	name: string;
	source: string;
	slug: string;
	installs: number;
	url: string;
}

export class SkillsRegistryError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = 'SkillsRegistryError';
	}
}

// --- token storage (encrypted in system_meta) ---

export async function setRegistryToken(db: Db, key: Buffer, token: string): Promise<void> {
	const trimmed = token.trim();
	if (!trimmed) {
		await deleteSystemMeta(db, REGISTRY_TOKEN_KEY);
		return;
	}
	await setSystemMeta(db, REGISTRY_TOKEN_KEY, encrypt(trimmed, key));
}

export async function getRegistryToken(db: Db, key: Buffer): Promise<string | null> {
	const stored = await getSystemMeta(db, REGISTRY_TOKEN_KEY);
	if (!stored) return null;
	try {
		return decrypt(stored, key);
	} catch {
		return null;
	}
}

export async function hasRegistryToken(db: Db): Promise<boolean> {
	return (await getSystemMeta(db, REGISTRY_TOKEN_KEY)) !== null;
}

// --- registry HTTP ---

async function registryGet(path: string, token: string | null): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(`${baseUrl()}${path}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
			signal: controller.signal,
		});
	} catch (e) {
		if ((e as Error).name === 'AbortError') {
			throw new SkillsRegistryError('skills.sh request timed out', 504);
		}
		throw new SkillsRegistryError(`skills.sh request failed: ${(e as Error).message}`, 502);
	} finally {
		clearTimeout(timer);
	}
}

export async function searchRegistry(
	token: string | null,
	query: string,
	limit = 20,
): Promise<RegistrySearchHit[]> {
	const q = query.trim();
	if (q.length < 2) {
		throw new SkillsRegistryError('Search query must be at least 2 characters', 400);
	}
	const clamped = Math.min(50, Math.max(1, Math.floor(limit) || 20));
	const res = await registryGet(
		`/api/v1/skills/search?q=${encodeURIComponent(q)}&limit=${clamped}`,
		token,
	);
	if (res.status === 401 || res.status === 403) {
		throw new SkillsRegistryError(
			'skills.sh rejected the request — check the configured token',
			401,
		);
	}
	if (!res.ok) {
		throw new SkillsRegistryError(`skills.sh search failed (HTTP ${res.status})`, 502);
	}
	const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
	const rows = Array.isArray(body.data) ? body.data : [];
	return rows
		.map((d) => ({
			id: String(d.id ?? ''),
			name: String(d.name ?? d.slug ?? d.id ?? ''),
			source: String(d.source ?? ''),
			slug: String(d.slug ?? ''),
			installs: Number(d.installs ?? 0) || 0,
			url: String(d.url ?? ''),
		}))
		.filter((d) => d.id);
}

/**
 * Fetch one skill's raw SKILL.md. Prefers the skills.sh API (needs a token), and
 * falls back to an anonymous GitHub raw fetch when no token is configured.
 */
async function fetchRegistrySkillMarkdown(
	token: string | null,
	id: string,
): Promise<{ markdown: string; defaultSlug: string; sourceUrl: string }> {
	const cleanId = id.trim().replace(/^\/+|\/+$/g, '');
	if (!SKILL_ID_RE.test(cleanId)) {
		throw new SkillsRegistryError('Invalid skill id (expected owner/repo/skill)', 400);
	}
	const [owner, repo, skill] = cleanId.split('/');

	if (token) {
		const res = await registryGet(`/api/v1/skills/${cleanId}`, token);
		if (res.status === 401 || res.status === 403) {
			throw new SkillsRegistryError(
				'skills.sh rejected the request — check the configured token',
				401,
			);
		}
		if (res.ok) {
			const body = (await res.json()) as { files?: Array<{ path: string; contents: string }> };
			const file = (body.files ?? []).find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
			if (file?.contents) {
				return {
					markdown: file.contents,
					defaultSlug: skill,
					sourceUrl: `${baseUrl()}/${cleanId}`,
				};
			}
		}
	}

	// Anonymous GitHub raw fallback. The standard layout is skills/<name>/SKILL.md;
	// the default branch is usually main, occasionally master.
	for (const branch of ['main', 'master']) {
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/skills/${skill}/SKILL.md`;
		try {
			const { content } = await downloadSkillContent(rawUrl);
			return { markdown: content, defaultSlug: skill, sourceUrl: rawUrl };
		} catch (e) {
			if (e instanceof SkillDownloadError && e.reason === 'not_found') continue;
			throw new SkillsRegistryError(`Failed to fetch skill: ${(e as Error).message}`, 502);
		}
	}
	throw new SkillsRegistryError(
		token
			? 'Skill not found on skills.sh or GitHub'
			: 'Skill not found on GitHub (configure a skills.sh token for full registry access)',
		404,
	);
}

/**
 * Fetch a registry skill and upsert it into the global skills catalog. Mirrors
 * the `fetch_skill_file` MCP tool insert so a registry-installed skill surfaces
 * in the manifest (and, when an agent triggers it, in run output via
 * `created_by_member_id`). Idempotent on the derived slug.
 */
export async function installRegistrySkill(
	db: Db,
	id: string,
	token: string | null,
	actorMemberId: string | null,
): Promise<{ id: string; slug: string; name: string; reused: boolean }> {
	const { markdown, defaultSlug, sourceUrl } = await fetchRegistrySkillMarkdown(token, id);
	const { data, body } = parseFrontmatter(markdown);
	const content = body.trim() || markdown.trim();
	const slug = toSlug(data.slug || defaultSlug || data.name || 'skill');
	if (!slug) throw new SkillsRegistryError('Could not derive a slug for the skill', 400);
	const name = data.name?.trim() || slug;
	const description = data.description?.trim() || deriveSkillSummary(content);
	const hash = createHash('sha256').update(content).digest('hex');

	const existing = await db.query<{ id: string; content: string }>(
		'SELECT id, content FROM skills WHERE slug = $1',
		[slug],
	);
	const upserted = await db.query<{ id: string; slug: string; name: string }>(
		`INSERT INTO skills (name, slug, description, content, source_url, content_hash, created_by_member_id, tags)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb)
		 ON CONFLICT (slug) DO UPDATE SET
		     name = EXCLUDED.name,
		     description = EXCLUDED.description,
		     content = EXCLUDED.content,
		     source_url = EXCLUDED.source_url,
		     content_hash = EXCLUDED.content_hash,
		     updated_at = now()
		 RETURNING id, slug, name`,
		[name, slug, description, content, sourceUrl, hash, actorMemberId],
	);
	await recordSkillRevisionIfChanged(
		db,
		upserted.rows[0].id,
		existing.rows[0]?.content ?? null,
		content,
		'Updated from registry',
		actorMemberId,
	);
	return { ...upserted.rows[0], reused: existing.rows.length > 0 };
}

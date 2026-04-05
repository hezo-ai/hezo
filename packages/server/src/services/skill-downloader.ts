import { createHash } from 'node:crypto';
import type { SkillManifestEntry } from '@hezo/shared';
import {
	deleteSkillFile,
	readSkillManifest,
	resolveSkillsPath,
	writeSkillFile,
	writeSkillManifest,
} from '../lib/docs';

const MAX_SKILL_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

export class SkillDownloadError extends Error {
	constructor(
		message: string,
		public readonly reason:
			| 'invalid_url'
			| 'network'
			| 'not_found'
			| 'too_large'
			| 'timeout'
			| 'forbidden_scheme',
	) {
		super(message);
		this.name = 'SkillDownloadError';
	}
}

/**
 * Convert a GitHub blob URL to its raw content URL.
 * Accepts raw URLs and passes them through unchanged.
 * Accepts non-GitHub URLs and passes them through unchanged.
 */
export function parseGitHubRawUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new SkillDownloadError(`Invalid URL: ${input}`, 'invalid_url');
	}

	if (url.hostname === 'github.com') {
		const parts = url.pathname.split('/').filter(Boolean);
		// /{owner}/{repo}/blob/{branch}/{...path}
		if (parts.length >= 5 && parts[2] === 'blob') {
			const owner = parts[0];
			const repo = parts[1];
			const branch = parts[3];
			const path = parts.slice(4).join('/');
			return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
		}
	}

	return url.toString();
}

function assertAllowedScheme(urlStr: string): void {
	const url = new URL(urlStr);
	if (url.protocol === 'https:') return;
	if (url.protocol === 'http:' && process.env.NODE_ENV !== 'production') return;
	throw new SkillDownloadError(
		`Only HTTPS URLs are supported (got ${url.protocol})`,
		'forbidden_scheme',
	);
}

/**
 * Fetch a skill file from a URL with size and timeout limits.
 */
export async function downloadSkillContent(
	sourceUrl: string,
): Promise<{ content: string; hash: string }> {
	const resolvedUrl = parseGitHubRawUrl(sourceUrl);
	assertAllowedScheme(resolvedUrl);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(resolvedUrl, {
			redirect: 'follow',
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if ((err as Error).name === 'AbortError') {
			throw new SkillDownloadError(`Request timed out after ${DOWNLOAD_TIMEOUT_MS}ms`, 'timeout');
		}
		throw new SkillDownloadError(`Network error: ${(err as Error).message}`, 'network');
	}
	clearTimeout(timer);

	if (!response.ok) {
		throw new SkillDownloadError(
			`Download failed with status ${response.status}`,
			response.status === 404 ? 'not_found' : 'network',
		);
	}

	const contentLength = response.headers.get('content-length');
	if (contentLength && Number.parseInt(contentLength, 10) > MAX_SKILL_BYTES) {
		throw new SkillDownloadError(
			`Skill content exceeds maximum size of ${MAX_SKILL_BYTES} bytes`,
			'too_large',
		);
	}

	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_SKILL_BYTES) {
		throw new SkillDownloadError(
			`Skill content exceeds maximum size of ${MAX_SKILL_BYTES} bytes`,
			'too_large',
		);
	}

	const content = new TextDecoder('utf-8').decode(buffer);
	const hash = createHash('sha256').update(content).digest('hex');
	return { content, hash };
}

export interface SkillInput {
	name: string;
	slug: string;
	description: string;
	source_url: string;
}

/**
 * Download a skill and save it to the company skills directory,
 * updating the manifest. Overwrites any existing skill with the same slug.
 */
export async function downloadAndSaveSkill(
	dataDir: string,
	companySlug: string,
	skill: SkillInput,
): Promise<SkillManifestEntry> {
	const { content, hash } = await downloadSkillContent(skill.source_url);
	const skillsDir = resolveSkillsPath(dataDir, companySlug);

	writeSkillFile(skillsDir, skill.slug, content);

	const manifest = readSkillManifest(skillsDir);
	const entry: SkillManifestEntry = {
		name: skill.name,
		slug: skill.slug,
		description: skill.description,
		source_url: skill.source_url,
		content_hash: hash,
		last_synced_at: new Date().toISOString(),
	};

	const existingIndex = manifest.skills.findIndex((s) => s.slug === skill.slug);
	if (existingIndex >= 0) {
		manifest.skills[existingIndex] = entry;
	} else {
		manifest.skills.push(entry);
	}
	writeSkillManifest(skillsDir, manifest);

	return entry;
}

/**
 * Re-download an existing skill from its stored source URL.
 */
export async function syncSkill(
	dataDir: string,
	companySlug: string,
	slug: string,
): Promise<SkillManifestEntry> {
	const skillsDir = resolveSkillsPath(dataDir, companySlug);
	const manifest = readSkillManifest(skillsDir);
	const existing = manifest.skills.find((s) => s.slug === slug);
	if (!existing) {
		throw new SkillDownloadError(`Skill not found: ${slug}`, 'not_found');
	}
	return downloadAndSaveSkill(dataDir, companySlug, {
		name: existing.name,
		slug: existing.slug,
		description: existing.description,
		source_url: existing.source_url,
	});
}

/**
 * Remove a skill from the filesystem and manifest.
 */
export function removeSkill(dataDir: string, companySlug: string, slug: string): boolean {
	const skillsDir = resolveSkillsPath(dataDir, companySlug);
	const manifest = readSkillManifest(skillsDir);
	const index = manifest.skills.findIndex((s) => s.slug === slug);
	if (index < 0) return false;
	manifest.skills.splice(index, 1);
	writeSkillManifest(skillsDir, manifest);
	deleteSkillFile(skillsDir, slug);
	return true;
}

/**
 * Update a skill's metadata (name, description) in the manifest.
 */
export function updateSkillMetadata(
	dataDir: string,
	companySlug: string,
	slug: string,
	update: { name?: string; description?: string },
): SkillManifestEntry | null {
	const skillsDir = resolveSkillsPath(dataDir, companySlug);
	const manifest = readSkillManifest(skillsDir);
	const entry = manifest.skills.find((s) => s.slug === slug);
	if (!entry) return null;
	if (update.name !== undefined) entry.name = update.name;
	if (update.description !== undefined) entry.description = update.description;
	writeSkillManifest(skillsDir, manifest);
	return entry;
}

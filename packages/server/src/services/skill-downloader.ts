import { createHash } from 'node:crypto';

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

/**
 * Re-download a skill from its source URL and return new content + hash.
 */
export async function syncSkillFromUrl(
	sourceUrl: string,
): Promise<{ content: string; hash: string }> {
	return downloadSkillContent(sourceUrl);
}

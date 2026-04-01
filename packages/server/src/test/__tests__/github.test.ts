import { describe, expect, it } from 'vitest';
import { parseGitHubUrl, validateRepoAccess, type FetchFn } from '../../services/github';

describe('parseGitHubUrl', () => {
	it('parses https://github.com/owner/repo', () => {
		expect(parseGitHubUrl('https://github.com/acme/frontend')).toEqual({
			owner: 'acme',
			repo: 'frontend',
		});
	});

	it('parses https://github.com/owner/repo/', () => {
		expect(parseGitHubUrl('https://github.com/acme/frontend/')).toEqual({
			owner: 'acme',
			repo: 'frontend',
		});
	});

	it('parses http://github.com/owner/repo', () => {
		expect(parseGitHubUrl('http://github.com/acme/frontend')).toEqual({
			owner: 'acme',
			repo: 'frontend',
		});
	});

	it('parses github.com/owner/repo without protocol', () => {
		expect(parseGitHubUrl('github.com/acme/frontend')).toEqual({
			owner: 'acme',
			repo: 'frontend',
		});
	});

	it('parses owner/repo shorthand', () => {
		expect(parseGitHubUrl('acme/frontend')).toEqual({
			owner: 'acme',
			repo: 'frontend',
		});
	});

	it('handles dots and hyphens in names', () => {
		expect(parseGitHubUrl('https://github.com/my-org/my.repo-name')).toEqual({
			owner: 'my-org',
			repo: 'my.repo-name',
		});
	});

	it('returns null for invalid URLs', () => {
		expect(parseGitHubUrl('')).toBeNull();
		expect(parseGitHubUrl('not-a-url')).toBeNull();
		expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
		expect(parseGitHubUrl('https://github.com/')).toBeNull();
		expect(parseGitHubUrl('https://github.com/owner')).toBeNull();
		expect(parseGitHubUrl('https://github.com/owner/repo/extra/path')).toBeNull();
	});
});

describe('validateRepoAccess', () => {
	it('returns accessible=true for 200', async () => {
		const fetchFn: FetchFn = async () => new Response('{}', { status: 200 });
		const result = await validateRepoAccess('acme', 'frontend', 'token', fetchFn);
		expect(result).toEqual({ accessible: true, status: 200 });
	});

	it('returns accessible=false for 404', async () => {
		const fetchFn: FetchFn = async () => new Response('not found', { status: 404 });
		const result = await validateRepoAccess('acme', 'frontend', 'token', fetchFn);
		expect(result).toEqual({ accessible: false, status: 404 });
	});

	it('returns accessible=false for 403', async () => {
		const fetchFn: FetchFn = async () => new Response('forbidden', { status: 403 });
		const result = await validateRepoAccess('acme', 'frontend', 'token', fetchFn);
		expect(result).toEqual({ accessible: false, status: 403 });
	});

	it('sends correct headers', async () => {
		let capturedHeaders: Headers | null = null;
		const fetchFn: FetchFn = async (_url, init) => {
			capturedHeaders = new Headers(init?.headers);
			return new Response('{}', { status: 200 });
		};
		await validateRepoAccess('acme', 'frontend', 'my-token', fetchFn);
		expect(capturedHeaders!.get('Authorization')).toBe('Bearer my-token');
		expect(capturedHeaders!.get('User-Agent')).toBe('Hezo/1.0');
	});

	it('calls the correct GitHub API URL', async () => {
		let capturedUrl = '';
		const fetchFn: FetchFn = async (url) => {
			capturedUrl = typeof url === 'string' ? url : url.toString();
			return new Response('{}', { status: 200 });
		};
		await validateRepoAccess('my-org', 'my-repo', 'token', fetchFn);
		expect(capturedUrl).toBe('https://api.github.com/repos/my-org/my-repo');
	});
});

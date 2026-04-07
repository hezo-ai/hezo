import { describe, expect, it } from 'vitest';
import {
	type FetchFn,
	registerSSHKeyOnGitHub,
	removeSSHKeyFromGitHub,
} from '../../services/github';

describe('registerSSHKeyOnGitHub', () => {
	it('returns key id on success (200)', async () => {
		const fetchFn: FetchFn = async () => new Response(JSON.stringify({ id: 42 }), { status: 200 });
		const result = await registerSSHKeyOnGitHub('ssh-ed25519 AAAA...', 'my-key', 'token', fetchFn);
		expect(result).toEqual({ id: 42 });
	});

	it('throws on non-ok response (422)', async () => {
		const fetchFn: FetchFn = async () => new Response('key already exists', { status: 422 });
		await expect(
			registerSSHKeyOnGitHub('ssh-ed25519 AAAA...', 'my-key', 'token', fetchFn),
		).rejects.toThrow('Failed to register SSH key on GitHub (422): key already exists');
	});

	it('sends correct headers and body', async () => {
		let capturedUrl = '';
		let capturedInit: RequestInit | undefined;
		const fetchFn: FetchFn = async (url, init) => {
			capturedUrl = typeof url === 'string' ? url : url.toString();
			capturedInit = init;
			return new Response(JSON.stringify({ id: 99 }), { status: 200 });
		};
		await registerSSHKeyOnGitHub('ssh-ed25519 AAAA...', 'deploy-key', 'my-token', fetchFn);

		expect(capturedUrl).toBe('https://api.github.com/user/keys');
		expect(capturedInit?.method).toBe('POST');

		const headers = new Headers(capturedInit?.headers);
		expect(headers.get('Authorization')).toBe('Bearer my-token');
		expect(headers.get('Accept')).toBe('application/vnd.github+json');
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(headers.get('User-Agent')).toBe('Hezo/1.0');

		expect(JSON.parse(capturedInit?.body as string)).toEqual({
			title: 'deploy-key',
			key: 'ssh-ed25519 AAAA...',
		});
	});
});

describe('removeSSHKeyFromGitHub', () => {
	it('succeeds on 204 response', async () => {
		const fetchFn: FetchFn = async () => new Response(null, { status: 204 });
		await expect(removeSSHKeyFromGitHub(42, 'token', fetchFn)).resolves.toBeUndefined();
	});

	it('succeeds silently on 404 (key already removed)', async () => {
		const fetchFn: FetchFn = async () => new Response('not found', { status: 404 });
		await expect(removeSSHKeyFromGitHub(42, 'token', fetchFn)).resolves.toBeUndefined();
	});

	it('throws on other error status (500)', async () => {
		const fetchFn: FetchFn = async () => new Response('internal server error', { status: 500 });
		await expect(removeSSHKeyFromGitHub(42, 'token', fetchFn)).rejects.toThrow(
			'Failed to remove SSH key from GitHub (500)',
		);
	});

	it('sends correct headers and calls correct URL', async () => {
		let capturedUrl = '';
		let capturedInit: RequestInit | undefined;
		const fetchFn: FetchFn = async (url, init) => {
			capturedUrl = typeof url === 'string' ? url : url.toString();
			capturedInit = init;
			return new Response(null, { status: 204 });
		};
		await removeSSHKeyFromGitHub(7, 'my-token', fetchFn);

		expect(capturedUrl).toBe('https://api.github.com/user/keys/7');
		expect(capturedInit?.method).toBe('DELETE');

		const headers = new Headers(capturedInit?.headers);
		expect(headers.get('Authorization')).toBe('Bearer my-token');
		expect(headers.get('Accept')).toBe('application/vnd.github+json');
		expect(headers.get('User-Agent')).toBe('Hezo/1.0');
	});
});

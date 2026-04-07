import { describe, expect, it } from 'vitest';
import { parseGitHubRawUrl, SkillDownloadError } from '../../services/skill-downloader';

describe('SkillDownloadError', () => {
	it('has the correct name property', () => {
		const err = new SkillDownloadError('something went wrong', 'invalid_url');
		expect(err.name).toBe('SkillDownloadError');
	});

	it('stores the reason property', () => {
		const reasons = [
			'invalid_url',
			'network',
			'not_found',
			'too_large',
			'timeout',
			'forbidden_scheme',
		] as const;

		for (const reason of reasons) {
			const err = new SkillDownloadError('msg', reason);
			expect(err.reason).toBe(reason);
		}
	});

	it('is an instance of Error', () => {
		const err = new SkillDownloadError('msg', 'network');
		expect(err).toBeInstanceOf(Error);
	});

	it('carries the message', () => {
		const err = new SkillDownloadError('download failed', 'not_found');
		expect(err.message).toBe('download failed');
	});
});

describe('parseGitHubRawUrl', () => {
	it('converts a github.com blob URL to a raw.githubusercontent.com URL', () => {
		const input = 'https://github.com/owner/repo/blob/main/path/file.md';
		const result = parseGitHubRawUrl(input);
		expect(result).toBe('https://raw.githubusercontent.com/owner/repo/main/path/file.md');
	});

	it('handles nested paths with multiple segments', () => {
		const input = 'https://github.com/owner/repo/blob/feature-branch/dir/subdir/file.ts';
		const result = parseGitHubRawUrl(input);
		expect(result).toBe(
			'https://raw.githubusercontent.com/owner/repo/feature-branch/dir/subdir/file.ts',
		);
	});

	it('passes through raw.githubusercontent.com URLs unchanged', () => {
		const input = 'https://raw.githubusercontent.com/owner/repo/main/file.md';
		const result = parseGitHubRawUrl(input);
		expect(result).toBe(input);
	});

	it('passes through non-GitHub URLs unchanged', () => {
		const input = 'https://example.com/some/path/file.md';
		const result = parseGitHubRawUrl(input);
		expect(result).toBe(input);
	});

	it('throws SkillDownloadError with reason invalid_url for a plain string', () => {
		expect(() => parseGitHubRawUrl('not-a-url')).toThrow(SkillDownloadError);
		try {
			parseGitHubRawUrl('not-a-url');
		} catch (err) {
			expect((err as SkillDownloadError).reason).toBe('invalid_url');
		}
	});

	it('throws SkillDownloadError with reason invalid_url for an empty string', () => {
		expect(() => parseGitHubRawUrl('')).toThrow(SkillDownloadError);
		try {
			parseGitHubRawUrl('');
		} catch (err) {
			expect((err as SkillDownloadError).reason).toBe('invalid_url');
		}
	});

	it('does not convert github.com URLs that are not blob paths', () => {
		// A github.com URL without /blob/ in the right position should pass through unchanged
		const input = 'https://github.com/owner/repo/tree/main/path';
		const result = parseGitHubRawUrl(input);
		expect(result).toBe(input);
	});
});

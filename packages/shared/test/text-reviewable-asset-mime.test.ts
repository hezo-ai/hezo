import { describe, expect, it } from 'vitest';
import { isTextReviewableAssetMime } from '../src/types/common';

describe('isTextReviewableAssetMime', () => {
	it('anchors text assets like documents', () => {
		expect(isTextReviewableAssetMime('text/markdown')).toBe(true);
		expect(isTextReviewableAssetMime('text/plain')).toBe(true);
	});

	it('treats every other type as whole-asset commentable', () => {
		// Visual types (region anchoring is future work — .dev/architecture.md).
		expect(isTextReviewableAssetMime('image/png')).toBe(false);
		expect(isTextReviewableAssetMime('image/jpeg')).toBe(false);
		expect(isTextReviewableAssetMime('image/svg+xml')).toBe(false);
		expect(isTextReviewableAssetMime('text/html')).toBe(false);
		// Non-visual types.
		expect(isTextReviewableAssetMime('application/pdf')).toBe(false);
		expect(isTextReviewableAssetMime('audio/mpeg')).toBe(false);
		expect(isTextReviewableAssetMime('application/octet-stream')).toBe(false);
		// Unknown / malformed.
		expect(isTextReviewableAssetMime('')).toBe(false);
		expect(isTextReviewableAssetMime('text/markdown; charset=utf-8')).toBe(false);
	});
});

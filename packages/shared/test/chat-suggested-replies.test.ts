import { describe, expect, it } from 'vitest';
import { parseSuggestedReplies } from '../src/chat-suggested-replies';

describe('parseSuggestedReplies', () => {
	it('splits a valid trailer off the body', () => {
		const parsed = parseSuggestedReplies('Want me to file it?\n\n[[suggest: Yes | Not yet]]');
		expect(parsed.body).toBe('Want me to file it?');
		expect(parsed.replies).toEqual(['Yes', 'Not yet']);
	});

	it('leaves a body with no trailer untouched', () => {
		const parsed = parseSuggestedReplies('Just an answer.');
		expect(parsed).toEqual({ body: 'Just an answer.', replies: null });
	});

	it('only takes the trailer from the very end', () => {
		const parsed = parseSuggestedReplies('[[suggest: Yes | No]] appeared mid-reply.\n\nDone.');
		expect(parsed.replies).toBeNull();
		expect(parsed.body).toContain('appeared mid-reply');
	});

	it('strips but refuses a malformed trailer - the body stays clean either way', () => {
		for (const trailer of [
			'[[suggest: ]]',
			'[[suggest: a | b | c | d]]',
			`[[suggest: ${'x'.repeat(81)}]]`,
		]) {
			const parsed = parseSuggestedReplies(`Reply.\n${trailer}`);
			expect(parsed.body).toBe('Reply.');
			expect(parsed.replies).toBeNull();
		}
	});

	it('caps at three short options and trims them', () => {
		const parsed = parseSuggestedReplies('Pick.\n[[suggest:  A  |  B  |  C  ]]');
		expect(parsed.replies).toEqual(['A', 'B', 'C']);
	});
});

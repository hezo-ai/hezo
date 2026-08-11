import { describe, expect, it } from 'vitest';
import { AGENT_HUMAN_NAME_MAX, humanNameError, inferGender } from '../src/avatar/name-gender';

describe('inferGender', () => {
	it('recognises common female names', () => {
		expect(inferGender('Priya')).toBe('f');
		expect(inferGender('Ada')).toBe('f');
		expect(inferGender('Elena')).toBe('f');
	});

	it('recognises common male names', () => {
		expect(inferGender('Max')).toBe('m');
		expect(inferGender('Leo')).toBe('m');
		expect(inferGender('Jonas')).toBe('m');
	});

	it('is case and whitespace insensitive, and keys on the first word', () => {
		expect(inferGender('  mAx  ')).toBe('m');
		expect(inferGender('Ana Maria')).toBe('f');
	});

	it('returns neutral for an unrecognised or empty name', () => {
		expect(inferGender('Zyphrax')).toBe('n');
		expect(inferGender('')).toBe('n');
		expect(inferGender(null)).toBe('n');
		expect(inferGender(undefined)).toBe('n');
	});
});

describe('humanNameError', () => {
	it('accepts ordinary names', () => {
		expect(humanNameError('Max')).toBeNull();
		expect(humanNameError('Ana Maria')).toBeNull();
		expect(humanNameError('Zoë')).toBeNull();
	});

	it('accepts an empty name, which is how a name is cleared', () => {
		expect(humanNameError('')).toBeNull();
		expect(humanNameError('   ')).toBeNull();
	});

	it('rejects a name longer than the maximum', () => {
		expect(humanNameError('a'.repeat(AGENT_HUMAN_NAME_MAX))).toBeNull();
		expect(humanNameError('a'.repeat(AGENT_HUMAN_NAME_MAX + 1))).toContain('or fewer');
	});

	it('rejects a name with no letter', () => {
		expect(humanNameError('12345')).toContain('letter');
	});

	it('rejects characters that would break the mention grammar', () => {
		expect(humanNameError('Max@work')).toContain('@');
		expect(humanNameError('Max\nOther')).toContain('@');
	});

	it('rejects a name that could never become a mention handle', () => {
		expect(humanNameError('***')).not.toBeNull();
	});
});

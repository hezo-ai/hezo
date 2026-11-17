import { describe, expect, it } from 'vitest';
import { credentialSecretValues, SECRET_MASK, SecretMasker } from '../src/lib/secret-masker';

const KEY = 'sk-test-0123456789abcdefABCDEF';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature-part';
const HEX = '7847a85a8c369d9076a158f04ff9777a';

function maskerWith(...values: string[]): SecretMasker {
	const masker = new SecretMasker();
	masker.addAll(values);
	return masker;
}

describe('SecretMasker.mask', () => {
	it('replaces every occurrence of every registered value', () => {
		const masker = maskerWith(KEY, TOKEN);
		const out = masker.mask(`AUTH=${KEY} Bearer ${TOKEN} again ${KEY}`);
		expect(out).toBe(`AUTH=${SECRET_MASK} Bearer ${SECRET_MASK} again ${SECRET_MASK}`);
	});

	it('ignores short, empty and repeated values', () => {
		const masker = new SecretMasker();
		masker.addAll(['', null, undefined, 'short', KEY, KEY]);
		expect(masker.size).toBe(1);
		expect(masker.mask('short text stays')).toBe('short text stays');
	});

	it('replaces a value that contains another one whole', () => {
		const inner = 'abcdefghijklmnop';
		const outer = `${inner}-and-more-bytes`;
		const masker = maskerWith(inner, outer);
		expect(masker.mask(`x ${outer} y ${inner}`)).toBe(`x ${SECRET_MASK} y ${SECRET_MASK}`);
	});
});

describe('SecretMasker.push', () => {
	it('catches a value split across two chunks of one stream', () => {
		const masker = maskerWith(HEX);
		const first = masker.push('stdout', `bridge node ${HEX.slice(0, 10)}`);
		const second = masker.push('stdout', `${HEX.slice(10)} 127.0.0.1:19082\n`);
		expect(first + second).toBe(`bridge node ${SECRET_MASK} 127.0.0.1:19082\n`);
		expect(first).not.toContain(HEX.slice(0, 10));
	});

	it('holds nothing back when a chunk ends in a newline', () => {
		const masker = maskerWith(KEY);
		expect(masker.push('stdout', 'a whole line\n')).toBe('a whole line\n');
		expect(masker.flush('stdout')).toBe('');
	});

	it('releases a tail that turned out not to be a secret', () => {
		const masker = maskerWith(KEY);
		const first = masker.push('stdout', 'prefix sk-te');
		expect(first).toBe('prefix ');
		expect(masker.push('stdout', 'a is not it\n')).toBe('sk-tea is not it\n');
	});

	it('keeps each stream carry separate', () => {
		const masker = maskerWith(KEY);
		const out = masker.push('stdout', KEY.slice(0, 8));
		const err = masker.push('stderr', 'error line\n');
		const rest = masker.push('stdout', `${KEY.slice(8)}\n`);
		expect(out).toBe('');
		expect(err).toBe('error line\n');
		expect(rest).toBe(`${SECRET_MASK}\n`);
	});

	it('bounds the carry below the longest value', () => {
		const masker = maskerWith(KEY);
		const out = masker.push('stdout', `${'x'.repeat(10_000)}${KEY.slice(0, KEY.length - 1)}`);
		// Everything but the possible start of the value goes out at once.
		expect(out).toBe('x'.repeat(10_000));
		expect(masker.flush('stdout')).toBe(SECRET_MASK);
	});

	it('masks a held tail of four or more characters when the stream ends', () => {
		const masker = maskerWith(HEX);
		// The stream ends partway through the value: nothing can complete it now.
		expect(masker.push('stderr', `HTTPS_PROXY=http://run:${HEX.slice(0, 31)}`)).toBe(
			'HTTPS_PROXY=http://run:',
		);
		expect(masker.flush('stderr')).toBe(SECRET_MASK);
	});

	it('releases a held tail shorter than four characters as it is', () => {
		const masker = maskerWith(KEY);
		expect(masker.push('stdout', 'yes')).toBe('ye');
		expect(masker.flush('stdout')).toBe('s');
	});

	it('passes text through unchanged before any value is registered', () => {
		const masker = new SecretMasker();
		expect(masker.push('stdout', 'sk-')).toBe('sk-');
		expect(masker.flush('stdout')).toBe('');
	});
});

describe('credentialSecretValues', () => {
	it('returns a plain key as itself', () => {
		expect(credentialSecretValues(KEY)).toContain(KEY);
	});

	it('also returns the trimmed form of a key saved with surrounding whitespace', () => {
		// The key works (HTTP strips the newline), but tool output collapses
		// whitespace, so only the trimmed form ever appears in a log.
		const masker = new SecretMasker();
		masker.addAll(credentialSecretValues(` ${KEY}\n`));
		expect(masker.mask(`[tool-result] ANTHROPIC_API_KEY=${KEY} HOME=/home/node`)).toBe(
			`[tool-result] ANTHROPIC_API_KEY=${SECRET_MASK} HOME=/home/node`,
		);
	});

	it('also returns every string inside a JSON credential blob', () => {
		const blob = JSON.stringify({
			tokens: { access_token: 'access-0123456789', refresh_token: 'refresh-0123456789' },
			scopes: ['scope-one-0123456789'],
			expires_at: 1794913016,
		});
		const values = credentialSecretValues(blob);
		expect(values).toContain(blob);
		expect(values).toContain('access-0123456789');
		expect(values).toContain('refresh-0123456789');
		expect(values).toContain('scope-one-0123456789');
	});
});

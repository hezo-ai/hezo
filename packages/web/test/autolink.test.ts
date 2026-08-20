import { expect, test } from 'vitest';
import { findLinkRanges, shiftLinkRanges } from '../src/lib/autolink';

// Link detection for the text surfaces that carry no markup (CSV cells, plain
// text assets). The rules mirror GFM's autolink literals so the same string
// links the same way whether it arrives as markdown or as raw file bytes.

function linked(text: string): Array<{ text: string; href: string }> {
	return findLinkRanges(text).map((r) => ({ text: text.slice(r.start, r.end), href: r.href }));
}

test('links http and https URLs, keeping the whole path and query', () => {
	expect(linked('https://x.com/PenguinWeb3/status/2087206311586918767')).toEqual([
		{
			text: 'https://x.com/PenguinWeb3/status/2087206311586918767',
			href: 'https://x.com/PenguinWeb3/status/2087206311586918767',
		},
	]);
	expect(linked('see http://example.com/a?b=1&c=2#frag now')).toEqual([
		{ text: 'http://example.com/a?b=1&c=2#frag', href: 'http://example.com/a?b=1&c=2#frag' },
	]);
});

test('a bare www host gains a scheme; a bare email becomes mailto', () => {
	expect(linked('www.example.com/docs')).toEqual([
		{ text: 'www.example.com/docs', href: 'https://www.example.com/docs' },
	]);
	expect(linked('ping ops@hezo.ai please')).toEqual([
		{ text: 'ops@hezo.ai', href: 'mailto:ops@hezo.ai' },
	]);
	expect(linked('mailto:ops@hezo.ai')).toEqual([
		{ text: 'mailto:ops@hezo.ai', href: 'mailto:ops@hezo.ai' },
	]);
});

test('trailing sentence punctuation and an unbalanced bracket stay outside the link', () => {
	expect(linked('Read https://example.com/a.')[0].text).toBe('https://example.com/a');
	expect(linked('Read https://example.com/a, then stop')[0].text).toBe('https://example.com/a');
	expect(linked('(see https://example.com/a)')[0].text).toBe('https://example.com/a');
	// A balanced pair inside the URL is part of it.
	expect(linked('https://en.wikipedia.org/wiki/Foo_(bar)')[0].text).toBe(
		'https://en.wikipedia.org/wiki/Foo_(bar)',
	);
});

test('finds several links in one string, in ascending non-overlapping order', () => {
	const text = 'a https://one.example/x b www.two.example c ops@three.example d';
	const ranges = findLinkRanges(text);
	expect(ranges.map((r) => r.href)).toEqual([
		'https://one.example/x',
		'https://www.two.example',
		'mailto:ops@three.example',
	]);
	for (let i = 1; i < ranges.length; i++) {
		expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end);
	}
});

test('only http, https, mailto and www forms produce an href', () => {
	// A dangerous scheme is never emitted - it is not one of the four forms.
	expect(findLinkRanges('javascript:alert(1)')).toEqual([]);
	expect(findLinkRanges('data:text/html;base64,PHNjcmlwdD4=')).toEqual([]);
	expect(findLinkRanges('ftp://files.example.com/pub')).toEqual([]);
	expect(findLinkRanges('file:///etc/passwd')).toEqual([]);
});

test('rejects candidates that are not a real host or continue a word', () => {
	// No domain to speak of.
	expect(findLinkRanges('http://')).toEqual([]);
	expect(findLinkRanges('https://nodot/path')).toEqual([]);
	// `www.` needs a domain under it.
	expect(findLinkRanges('www.local')).toEqual([]);
	// Mid-word matches are text, not links.
	expect(findLinkRanges('xhttps://example.com')).toEqual([]);
	// A localhost URL is a link - it is the one dotless host that resolves.
	expect(linked('http://localhost:3101/api')).toEqual([
		{ text: 'http://localhost:3101/api', href: 'http://localhost:3101/api' },
	]);
});

test('a URL is bounded by whitespace, quotes and angle brackets', () => {
	expect(linked('"https://example.com/a" and <https://example.com/b>')).toEqual([
		{ text: 'https://example.com/a', href: 'https://example.com/a' },
		{ text: 'https://example.com/b', href: 'https://example.com/b' },
	]);
	// A newline inside a quoted CSV cell ends the URL.
	expect(linked('https://example.com/a\nnext line')[0].text).toBe('https://example.com/a');
});

test('shiftLinkRanges moves ranges into a wider stream', () => {
	const ranges = findLinkRanges('https://example.com/a');
	expect(shiftLinkRanges(ranges, 10)).toEqual([
		{ start: 10, end: 31, href: 'https://example.com/a' },
	]);
	// A zero offset is the identity.
	expect(shiftLinkRanges(ranges, 0)).toBe(ranges);
});

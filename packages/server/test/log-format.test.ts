import { describe, expect, it } from 'vitest';
import { splitLogLines } from '../src/services/log-format';

describe('splitLogLines', () => {
	it('splits on newlines and drops empty lines', () => {
		expect(splitLogLines('a\nb\n\nc\n')).toEqual(['a', 'b', 'c']);
	});

	it('normalizes \\r\\n line endings', () => {
		expect(splitLogLines('a\r\nb\r\n')).toEqual(['a', 'b']);
	});

	it('collapses carriage-return progress redraws to the final frame', () => {
		expect(
			splitLogLines('(Reading database 5%\r(Reading database 50%\r(Reading database 100%\n'),
		).toEqual(['(Reading database 100%']);
	});

	it('keeps the last non-empty frame when a redraw ends with a bare CR', () => {
		expect(splitLogLines('working...\rdone\r')).toEqual(['done']);
	});

	it('collapses redraws independently on each physical line', () => {
		expect(splitLogLines('x 1%\rx 100%\ny 2%\ry 99%\n')).toEqual(['x 100%', 'y 99%']);
	});

	it('returns an empty array for input with no visible content', () => {
		expect(splitLogLines('')).toEqual([]);
		expect(splitLogLines('\n\n')).toEqual([]);
	});
});

import { describe, expect, it } from 'vitest';
import { renderTerminalScreen } from '../src/services/sandbox/terminal-screen';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * The sequences below are the shapes a real repaint emits, taken from
 * `claude setup-token` under the login PTY. They are here because deleting
 * escape sequences and keeping the rest - which is what this replaced - reads
 * several of them wrong while looking right, and a token that is the right shape
 * and the wrong value is stored and then refused on every run.
 */
describe('renderTerminalScreen', () => {
	/**
	 * The prefix lands in columns 2..8 and the cursor is then sent to column 10,
	 * so column 9 keeps whatever an earlier pass left there. That character is in
	 * the stream nowhere near the fragments either side of it.
	 */
	const REPAINT = `${ESC}[9Go\r${ESC}[2Gsk-ant-${ESC}[10Gat01-BBB`;

	it('keeps a character the repaint jumped over', () => {
		expect(renderTerminalScreen(REPAINT)).toBe(' sk-ant-oat01-BBB');
	});

	it('splices fragments together when the escapes are merely deleted', () => {
		// The same stream read the way this replaced, kept as the statement of what
		// breaks: a value of the right shape, missing a character.
		const stripped = REPAINT.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '').replace(
			/\r/g,
			'\n',
		);
		expect(stripped).toContain('sk-ant-at01-BBB');
		expect(renderTerminalScreen(REPAINT)).not.toContain('sk-ant-at01-');
	});

	it('returns a carriage return to the start of its own row, not to a new one', () => {
		// The old tail survives because nothing erased it - which is why the erase
		// below has to be honoured rather than skipped as decoration.
		expect(renderTerminalScreen('loading…\rdone')).toBe('doneing…');
	});

	it('leaves a value the CLI wrapped on two rows, because that is where it put it', () => {
		// Not joined: a row break the CLI chose is indistinguishable here from one
		// it meant. The PTY is sized so nothing these CLIs print reaches this case.
		expect(renderTerminalScreen('sk-ant-oat01-AAA\nBBB')).toBe('sk-ant-oat01-AAA\nBBB');
	});

	it('honours erase-to-end-of-line, so a shortened line does not keep its old tail', () => {
		expect(renderTerminalScreen(`abcdefgh\r${ESC}[3Cxy${ESC}[K`)).toBe('abcxy');
	});

	it('honours cursor up and down, so a box repainted in place composes', () => {
		const painted = `one\ntwo\nthree${ESC}[2A\rONE`;
		expect(renderTerminalScreen(painted)).toBe('ONE\ntwo\nthree');
	});

	it('drops OSC sequences, which occupy no cell', () => {
		expect(renderTerminalScreen(`a${ESC}]8;;https://example.com${BEL}b${ESC}]8;;${BEL}c`)).toBe(
			'abc',
		);
		expect(renderTerminalScreen(`a${ESC}]0;window title${ESC}\\b`)).toBe('ab');
	});

	it('drops colour and mode switches without eating the text around them', () => {
		expect(renderTerminalScreen(`${ESC}[?25l${ESC}[32mgreen${ESC}[0m${ESC}[?25h`)).toBe('green');
	});

	it('restores a saved cursor, so a frame that parks and returns lands where it left', () => {
		expect(renderTerminalScreen(`abc${ESC}7\rxy${ESC}8Z`)).toBe('xycZ');
	});

	it('reads a value back whole from a stream with no escapes at all', () => {
		// A CLI writing to a pipe rather than a PTY paints nothing, and must come
		// back unchanged - the same function serves both.
		const plain = '1. Open this link\n   https://auth.openai.com/codex/device\n\n   R314-OEASM\n';
		expect(renderTerminalScreen(plain)).toContain('https://auth.openai.com/codex/device');
		expect(renderTerminalScreen(plain)).toContain('R314-OEASM');
	});

	it('stops following a cursor driven past its bound instead of growing without limit', () => {
		const runaway = `${ESC}[999999B${ESC}[999999Cx`;
		expect(renderTerminalScreen(runaway).length).toBeLessThan(10_000);
	});
});

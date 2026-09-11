/**
 * Compose a PTY byte stream into the screen it paints.
 *
 * A full-screen CLI does not write text, it writes *cells*: it moves the cursor
 * and repaints only what changed, so a single logical value reaches the stream
 * as several fragments at coordinates, spread across frames. Reading such a
 * value by deleting the escape sequences and keeping the rest is unsound in two
 * ways, and both silently corrupt the result rather than failing:
 *
 * - **A skipped column is a lost character.** A redraw that re-writes only the
 *   changed part jumps the cursor over a character it left standing, so
 *   deleting the jump splices the fragments either side of it together and the
 *   untouched character is gone.
 * - **A wrapped value is a truncated one.** Text laid out to the terminal's
 *   width arrives as fragments on separate rows, and a matcher that stops at a
 *   line break takes the first fragment for the whole value.
 *
 * Composing the cells answers both: the value is read from the finished screen,
 * where it sits exactly as an operator would see it.
 *
 * Every escape that moves the cursor or erases is honoured; the rest - colour,
 * mode switches, hyperlinks - is skipped, since none of it changes what
 * character ends up in which cell. OSC 8 targets are read from the raw stream by
 * `parseOsc8Links`, which is why they need no representation here.
 */

/**
 * How much screen is kept.
 *
 * A bound rather than an unbounded canvas because the input is a log that grows
 * for as long as a sign-in runs, and the cost of composing it is paid on every
 * poll. Both are far above what any sign-in paints, so clamping never truncates
 * real output - it only refuses to follow a cursor move into open space.
 */
const MAX_ROWS = 4096;
const MAX_COLS = 4096;

/** A parsed CSI: its numeric parameters and the final byte that names it. */
interface ControlSequence {
	params: number[];
	final: string;
	end: number;
}

/**
 * Read one CSI starting at the `[` after ESC.
 *
 * Parameter bytes, then intermediate bytes, then the final byte - the shape ECMA
 * 48 defines, so a sequence carrying private markers (`?`, `<`) or intermediates
 * is consumed whole even when nothing below acts on it.
 */
function readControlSequence(raw: string, start: number): ControlSequence {
	let i = start;
	while (i < raw.length && /[0-9;?<>=!]/.test(raw[i])) i += 1;
	while (i < raw.length && /[ -/]/.test(raw[i])) i += 1;
	const params = raw
		.slice(start, i)
		.replace(/[^0-9;]/g, '')
		.split(';')
		.map((p) => (p === '' ? Number.NaN : Number(p)));
	return { params, final: raw[i] ?? '', end: i + 1 };
}

class Screen {
	private readonly rows: string[][] = [];
	private row = 0;
	private col = 0;
	private savedRow = 0;
	private savedCol = 0;

	/** The row at the cursor, grown to reach it. */
	private currentRow(): string[] {
		while (this.rows.length <= this.row) this.rows.push([]);
		return this.rows[this.row];
	}

	write(ch: string): void {
		if (this.row >= MAX_ROWS || this.col >= MAX_COLS) return;
		const row = this.currentRow();
		while (row.length < this.col) row.push(' ');
		row[this.col] = ch;
		this.col += 1;
	}

	moveTo(row: number, col: number): void {
		this.row = Math.min(Math.max(0, row), MAX_ROWS);
		this.col = Math.min(Math.max(0, col), MAX_COLS);
	}

	moveBy(rows: number, cols: number): void {
		this.moveTo(this.row + rows, this.col + cols);
	}

	get position(): { row: number; col: number } {
		return { row: this.row, col: this.col };
	}

	saveCursor(): void {
		this.savedRow = this.row;
		this.savedCol = this.col;
	}

	restoreCursor(): void {
		this.moveTo(this.savedRow, this.savedCol);
	}

	/** Erase within the cursor's row: to its end, to its start, or all of it. */
	eraseInLine(mode: number): void {
		const row = this.currentRow();
		if (mode === 1) {
			for (let c = 0; c <= this.col && c < row.length; c += 1) row[c] = ' ';
		} else if (mode === 2) {
			row.length = 0;
		} else {
			row.length = Math.min(row.length, this.col);
		}
	}

	/** Erase the display: below the cursor, above it, or the whole screen. */
	eraseInDisplay(mode: number): void {
		if (mode === 1) {
			for (let r = 0; r < this.row && r < this.rows.length; r += 1) this.rows[r].length = 0;
			this.eraseInLine(1);
		} else if (mode === 2 || mode === 3) {
			this.rows.length = 0;
			this.moveTo(0, 0);
		} else {
			this.eraseInLine(0);
			this.rows.length = Math.min(this.rows.length, this.row + 1);
		}
	}

	/** The finished screen, one string per row with trailing blanks dropped. */
	render(): string {
		return this.rows.map((row) => row.join('').replace(/\s+$/, '')).join('\n');
	}
}

/**
 * The screen `raw` paints, as text - one line per row.
 *
 * Use this, not the raw stream, to read any value a CLI printed. The result is
 * what the operator sees, so a matcher run over it reads whole values rather
 * than the fragments the repaint happened to emit.
 */
export function renderTerminalScreen(raw: string): string {
	const screen = new Screen();

	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];

		if (ch === '\x1b') {
			const next = raw[i + 1];
			if (next === '[') {
				const { params, final, end } = readControlSequence(raw, i + 2);
				const n = Number.isNaN(params[0]) ? 1 : params[0];
				const { row, col } = screen.position;
				switch (final) {
					case 'A':
						screen.moveBy(-n, 0);
						break;
					case 'B':
						screen.moveBy(n, 0);
						break;
					case 'C':
						screen.moveBy(0, n);
						break;
					case 'D':
						screen.moveBy(0, -n);
						break;
					case 'E':
						screen.moveTo(row + n, 0);
						break;
					case 'F':
						screen.moveTo(row - n, 0);
						break;
					case 'G':
					case '`':
						screen.moveTo(row, n - 1);
						break;
					case 'd':
						screen.moveTo(n - 1, col);
						break;
					case 'H':
					case 'f':
						screen.moveTo(n - 1, (Number.isNaN(params[1]) ? 1 : params[1]) - 1);
						break;
					case 'J':
						screen.eraseInDisplay(Number.isNaN(params[0]) ? 0 : params[0]);
						break;
					case 'K':
						screen.eraseInLine(Number.isNaN(params[0]) ? 0 : params[0]);
						break;
					default:
						break;
				}
				i = end;
				continue;
			}
			if (next === ']') {
				// OSC, terminated by BEL or by ST. Skipped whole: a window title or a
				// hyperlink target occupies no cell.
				let j = i + 2;
				while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) {
					j += 1;
				}
				i = raw[j] === '\x07' ? j + 1 : j + 2;
				continue;
			}
			if (next === '7') {
				screen.saveCursor();
				i += 2;
				continue;
			}
			if (next === '8') {
				screen.restoreCursor();
				i += 2;
				continue;
			}
			if (next === 'M') {
				screen.moveBy(-1, 0);
				i += 2;
				continue;
			}
			if (next === 'D') {
				screen.moveBy(1, 0);
				i += 2;
				continue;
			}
			if (next === 'E') {
				screen.moveTo(screen.position.row + 1, 0);
				i += 2;
				continue;
			}
			// Charset and other intermediate-carrying escapes take one more byte.
			i += next !== undefined && /[()*+#%]/.test(next) ? 3 : 2;
			continue;
		}

		if (ch === '\r') {
			screen.moveTo(screen.position.row, 0);
			i += 1;
			continue;
		}
		if (ch === '\n') {
			// Line feed starts the next line, rather than dropping a row and keeping
			// the column. A PTY pairs it with a carriage return and both readings
			// agree; a CLI writing to a pipe emits it alone and means a new line. The
			// other reading would indent each successive line of piped output by the
			// length of the one before it.
			screen.moveTo(screen.position.row + 1, 0);
			i += 1;
			continue;
		}
		if (ch === '\b') {
			screen.moveBy(0, -1);
			i += 1;
			continue;
		}
		// Bell, and the shift-in/shift-out charset toggles: no cell, no cursor move.
		if (ch === '\x07' || ch === '\x0e' || ch === '\x0f') {
			i += 1;
			continue;
		}
		if (ch === '\t') {
			const { row, col } = screen.position;
			screen.moveTo(row, col + 8 - (col % 8));
			i += 1;
			continue;
		}

		screen.write(ch);
		i += 1;
	}

	return screen.render();
}

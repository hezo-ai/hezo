import { describe, expect, it } from 'vitest';
import { describeSignalExit, signalFromExitCode } from '../src/lib/exit-code';

describe('signalFromExitCode', () => {
	it('decodes the 128 + N convention for named signals', () => {
		expect(signalFromExitCode(137)).toEqual({ number: 9, name: 'SIGKILL' });
		expect(signalFromExitCode(143)).toEqual({ number: 15, name: 'SIGTERM' });
		expect(signalFromExitCode(139)).toEqual({ number: 11, name: 'SIGSEGV' });
		expect(signalFromExitCode(134)).toEqual({ number: 6, name: 'SIGABRT' });
	});

	it('renders an unnamed in-range signal as its number', () => {
		expect(signalFromExitCode(163)).toEqual({ number: 35, name: 'signal 35' });
	});

	it('returns null for an ordinary exit code', () => {
		for (const code of [0, 1, 2, 127, 128, 193, -1]) {
			expect(signalFromExitCode(code)).toBeNull();
		}
	});

	it('returns null for a missing or non-integer code', () => {
		expect(signalFromExitCode(null)).toBeNull();
		expect(signalFromExitCode(undefined)).toBeNull();
		expect(signalFromExitCode(137.5)).toBeNull();
	});
});

describe('describeSignalExit', () => {
	it('names the memory cap for a SIGKILL, which is what the reader must change', () => {
		const message = describeSignalExit(137, { memoryLimitGib: 6 });
		expect(message).toContain('SIGKILL');
		expect(message).toContain('137');
		expect(message).toContain('out-of-memory');
		expect(message).toContain('6 GiB');
		expect(message).toContain('Containers page');
	});

	it('reports another signal without claiming it was memory', () => {
		const message = describeSignalExit(143, { memoryLimitGib: 6 });
		expect(message).toContain('SIGTERM');
		expect(message).toContain('143');
		expect(message).not.toContain('out-of-memory');
		expect(message).not.toContain('GiB');
	});

	it('returns null for an ordinary exit code', () => {
		expect(describeSignalExit(1, { memoryLimitGib: 6 })).toBeNull();
		expect(describeSignalExit(0, { memoryLimitGib: 6 })).toBeNull();
	});

	it('uses plain hyphens, the ban reaching every string the UI renders', () => {
		for (const code of [137, 143, 139]) {
			const message = describeSignalExit(code, { memoryLimitGib: 4 }) ?? '';
			expect(message).not.toContain('—');
			expect(message).not.toContain('–');
		}
	});
});

import { Logger, LogLevel } from '@hiddentao/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/logger';

// logger.ts patches Logger.prototype.shouldSkipLevel to consult a single
// module-level `currentMinLevel` that setLogLevel mutates, so every Logger
// instance (root + children, past or future) honours the current threshold on
// each call. We exercise that by building a probe Logger with a recording
// transport and asserting exactly which levels pass through after each
// setLogLevel(...) — covering all four switch arms.

interface Recorded {
	level: LogLevel;
	message: string;
}

function makeProbe(): { logger: Logger; records: Recorded[] } {
	const records: Recorded[] = [];
	const logger = new Logger({
		transports: [
			{
				write(entry: { level: LogLevel; message: string }) {
					records.push({ level: entry.level, message: entry.message });
				},
			},
		],
	});
	return { logger, records };
}

function levelsThatPass(logger: Logger, records: Recorded[]): LogLevel[] {
	records.length = 0;
	logger.debug('d');
	logger.info('i');
	logger.warn('w');
	logger.error('e');
	return records.map((r) => r.level);
}

describe('setLogLevel', () => {
	// Restore the default so this suite can't leak a raised/lowered threshold
	// into other files that share the patched prototype + module state.
	afterEach(() => setLogLevel('info'));

	it('debug lets every level through', () => {
		const { logger, records } = makeProbe();
		setLogLevel('debug');
		expect(levelsThatPass(logger, records)).toEqual([
			LogLevel.DEBUG,
			LogLevel.INFO,
			LogLevel.WARN,
			LogLevel.ERROR,
		]);
	});

	it('info gates out debug', () => {
		const { logger, records } = makeProbe();
		setLogLevel('info');
		expect(levelsThatPass(logger, records)).toEqual([LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]);
	});

	it('warn gates out debug and info', () => {
		const { logger, records } = makeProbe();
		setLogLevel('warn');
		expect(levelsThatPass(logger, records)).toEqual([LogLevel.WARN, LogLevel.ERROR]);
	});

	it('error gates out everything below error', () => {
		const { logger, records } = makeProbe();
		setLogLevel('error');
		expect(levelsThatPass(logger, records)).toEqual([LogLevel.ERROR]);
	});

	it('applies retroactively to a logger created before the level change', () => {
		const { logger, records } = makeProbe();
		setLogLevel('error');
		expect(levelsThatPass(logger, records)).toEqual([LogLevel.ERROR]);
		setLogLevel('debug');
		expect(levelsThatPass(logger, records)).toHaveLength(4);
	});

	it('applies across child loggers (shared prototype gate)', () => {
		const { logger, records } = makeProbe();
		const child = logger.child('sub');
		setLogLevel('warn');
		records.length = 0;
		child.info('i');
		child.warn('w');
		expect(records.map((r) => r.level)).toEqual([LogLevel.WARN]);
	});
});

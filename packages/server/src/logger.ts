import { type LogEntry, Logger, LogLevel, type Transport } from '@hiddentao/logger';

const levelFromEnv = (process.env.LOG_LEVEL ?? '').toUpperCase();
const minLevel: LogLevel =
	levelFromEnv === 'DEBUG'
		? LogLevel.DEBUG
		: levelFromEnv === 'WARN'
			? LogLevel.WARN
			: levelFromEnv === 'ERROR'
				? LogLevel.ERROR
				: LogLevel.INFO;

const LEVEL_COLORS: Record<string, (s: string) => string> = {
	[LogLevel.ERROR]: (s) => `\x1b[31m${s}\x1b[0m`,
	[LogLevel.WARN]: (s) => `\x1b[33m${s}\x1b[0m`,
	[LogLevel.DEBUG]: (s) => `\x1b[90m${s}\x1b[0m`,
};

class ServerConsoleTransport implements Transport {
	write(entry: LogEntry): void {
		const level = `[${entry.level.toLowerCase()}]`;
		const category = entry.category ? `<${entry.category}> ` : '';
		const message = entry.messageParts
			.map((p) =>
				typeof p === 'string' ? p : p instanceof Error ? p.stack || p.message : JSON.stringify(p),
			)
			.join(' ');
		const line = `${level} ${category}${message}`;
		const colorize = LEVEL_COLORS[entry.level];
		console.log(colorize ? colorize(line) : line);
	}
}

export const logger = new Logger({
	minLevel,
	transports: [new ServerConsoleTransport()],
});

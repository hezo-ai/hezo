import { Logger, LogLevel } from '@hiddentao/logger';
import { ConsoleTransport } from '@hiddentao/logger/transports/console';

// @hiddentao/logger snapshots `minLevel` into each child logger's options at
// construction time, so mutating the root's options after the fact wouldn't
// affect children created at module load. Patch the prototype's level gate
// to consult a single module-level variable instead — every logger instance,
// past or future, picks up the current setting on every log call.
const LEVEL_PRIORITY: Record<LogLevel, number> = {
	[LogLevel.DEBUG]: 0,
	[LogLevel.INFO]: 1,
	[LogLevel.WARN]: 2,
	[LogLevel.ERROR]: 3,
};

let currentMinLevel: LogLevel = LogLevel.INFO;

(Logger.prototype as unknown as { shouldSkipLevel: (l: LogLevel) => boolean }).shouldSkipLevel =
	function shouldSkipLevel(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentMinLevel];
	};

export const logger = new Logger({
	transports: [new ConsoleTransport({ showTimestamps: true })],
});

/**
 * Update the min log level applied across every Logger instance — root and
 * children alike. Called once at startup after the central config has been
 * resolved (see `parseConfig` in cli.ts).
 */
export function setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
	switch (level) {
		case 'debug':
			currentMinLevel = LogLevel.DEBUG;
			return;
		case 'info':
			currentMinLevel = LogLevel.INFO;
			return;
		case 'warn':
			currentMinLevel = LogLevel.WARN;
			return;
		case 'error':
			currentMinLevel = LogLevel.ERROR;
			return;
	}
}

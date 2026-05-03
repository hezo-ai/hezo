import { Logger, LogLevel } from '@hiddentao/logger';
import { ConsoleTransport } from '@hiddentao/logger/transports/console';

const levelFromEnv = (process.env.LOG_LEVEL ?? '').toUpperCase();
const minLevel: LogLevel =
	levelFromEnv === 'DEBUG'
		? LogLevel.DEBUG
		: levelFromEnv === 'WARN'
			? LogLevel.WARN
			: levelFromEnv === 'ERROR'
				? LogLevel.ERROR
				: LogLevel.INFO;

export const logger = new Logger({
	minLevel,
	transports: [new ConsoleTransport({ showTimestamps: true })],
});

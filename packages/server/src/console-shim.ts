import { inspect } from 'node:util';
import { logger } from './logger';

const mitm = logger.child('mitm-proxy');
const MARKER = 'http-mitm-proxy';
const LOGGER_MARKER = '@hiddentao/logger';

const fmt = (args: unknown[]) =>
	args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 }))).join(' ');

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let routing = false;

function wrap(method: ConsoleMethod, level: LogLevel) {
	const original = console[method].bind(console);
	console[method] = (...args: unknown[]) => {
		if (routing) {
			original(...args);
			return;
		}
		const stack = new Error().stack ?? '';
		if (stack.includes(LOGGER_MARKER)) {
			original(...args);
			return;
		}
		if (!stack.includes(MARKER)) {
			original(...args);
			return;
		}
		if (method === 'error' || method === 'warn') {
			return;
		}
		routing = true;
		try {
			mitm[level](fmt(args));
		} finally {
			routing = false;
		}
	};
}

wrap('debug', 'debug');
wrap('log', 'info');
wrap('info', 'info');
wrap('warn', 'warn');
wrap('error', 'error');

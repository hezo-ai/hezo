import { inspect } from 'node:util';
import { logger } from './logger';

const mitm = logger.child('mitm-proxy');
const MARKER = 'http-mitm-proxy';

const fmt = (args: unknown[]) =>
	args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 }))).join(' ');

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function wrap(method: ConsoleMethod, level: LogLevel) {
	const original = console[method].bind(console);
	console[method] = (...args: unknown[]) => {
		const stack = new Error().stack ?? '';
		if (stack.includes(MARKER)) {
			mitm[level](fmt(args));
			return;
		}
		original(...args);
	};
}

wrap('debug', 'debug');
wrap('log', 'info');
wrap('info', 'info');
wrap('warn', 'warn');
wrap('error', 'error');

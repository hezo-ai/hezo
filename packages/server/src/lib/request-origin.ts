import type { Context } from 'hono';
import type { Env } from './types';

/**
 * The origin the client used to reach this instance, honoring reverse-proxy
 * forwarding headers. `x-forwarded-proto` may be a comma-separated chain when
 * multiple proxies are involved; the first entry is the client-facing scheme.
 */
export function requestOrigin(c: Context<Env>): string {
	const proto = (c.req.header('x-forwarded-proto') ?? 'http').split(',')[0].trim() || 'http';
	const host = c.req.header('host') ?? 'localhost';
	return `${proto}://${host}`;
}

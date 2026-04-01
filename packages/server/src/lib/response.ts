import type { Context } from 'hono';

export function ok(c: Context, data: unknown, status: 200 | 201 = 200) {
	return c.json({ data }, status);
}

export function err(
	c: Context,
	code: string,
	message: string,
	status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 500 | 503,
) {
	return c.json({ error: { code, message } }, status);
}

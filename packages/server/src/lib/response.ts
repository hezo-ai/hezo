import type { Context } from 'hono';

export function ok(c: Context, data: unknown, status: 200 | 201 = 200) {
	return c.json({ data }, status);
}

export function err(
	c: Context,
	code: string,
	message: string,
	status: 400 | 401 | 403 | 404 | 409 | 422 | 402 | 500,
) {
	return c.json({ error: { code, message } }, status);
}

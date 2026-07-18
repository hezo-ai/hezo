import {
	isAllowedProjectIconStoredMime,
	PROJECT_ICON_MAX_BYTES,
	PROJECT_ICON_MAX_DIMENSION,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { signEntityIconUrl, verifyEntityIconUrl } from '../lib/entity-icon-urls';
import { readImageDimensions } from '../lib/image-dimensions';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';

const log = logger.child('routes');

export const usersRoutes = new Hono<Env>();

// --- User avatar (icon) -------------------------------------------------------
// The single admin user (and any future human user) can carry a custom avatar,
// managed from the global Settings → Users page. Stored as bytes in the DB
// (user_icons, 1:1 with users) and served via an HMAC-signed public URL —
// mirrors the project/agent icon, generalized in `entity-icon-urls`.
const USER_ICON_KEY_PURPOSE = 'user-icon-url';
const USER_ICON_BASE_PATH = '/api/users';

/** Sign a user's icon URL from its `icon_updated_at` version, or null when unset. */
async function signUserIcon(
	c: Context<Env>,
	id: string,
	iconUpdatedAt: unknown,
): Promise<string | null> {
	if (typeof iconUpdatedAt === 'string' || iconUpdatedAt instanceof Date) {
		const version = Math.floor(new Date(iconUpdatedAt).getTime() / 1000);
		return signEntityIconUrl(
			USER_ICON_BASE_PATH,
			USER_ICON_KEY_PURPOSE,
			id,
			c.get('masterKeyManager'),
			version,
		);
	}
	return null;
}

// List human users (today just the admin) with a freshly-signed avatar URL.
// Superuser-only — this is a global instance-management surface.
usersRoutes.get('/users', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const result = await db.query<{
		id: string;
		display_name: string;
		is_superuser: boolean;
		icon_updated_at: string | null;
	}>(
		`SELECT u.id, u.display_name, u.is_superuser,
		   (SELECT ui.updated_at FROM user_icons ui WHERE ui.user_id = u.id) AS icon_updated_at
		 FROM users u
		 ORDER BY u.is_superuser DESC, u.display_name ASC`,
	);
	const rows = await Promise.all(
		result.rows.map(async (r) => ({
			id: r.id,
			display_name: r.display_name,
			is_superuser: r.is_superuser,
			icon_url: await signUserIcon(c, r.id, r.icon_updated_at),
			icon_updated_at: r.icon_updated_at,
		})),
	);
	return ok(c, rows);
});

// Upload (or replace) a user's avatar. The client normalizes any picked image to
// a square PNG ≤ PROJECT_ICON_MAX_DIMENSION before upload; the server
// re-validates content-type, byte size, and pixel dimensions defensively.
usersRoutes.put(
	'/users/:userId/icon',
	bodyLimit({
		maxSize: PROJECT_ICON_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Image exceeds the size limit', 400),
	}),
	async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		const userId = c.req.param('userId');

		const exists = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
		if (exists.rows.length === 0) return err(c, 'NOT_FOUND', 'User not found', 404);

		let form: Awaited<ReturnType<typeof c.req.parseBody>>;
		try {
			form = await c.req.parseBody({ all: false });
		} catch (e) {
			log.error('user icon parseBody failed:', e);
			return err(c, 'INVALID_REQUEST', 'Malformed upload', 400);
		}
		const file = form.file;
		if (!(file instanceof Blob)) {
			return err(c, 'INVALID_REQUEST', 'Missing file field', 400);
		}

		const contentType = file.type || 'application/octet-stream';
		if (!isAllowedProjectIconStoredMime(contentType)) {
			return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${contentType}`, 400);
		}
		if (file.size > PROJECT_ICON_MAX_BYTES) {
			return err(c, 'TOO_LARGE', 'Image exceeds the size limit', 400);
		}

		const buf = Buffer.from(await file.arrayBuffer());
		const dims = readImageDimensions(buf);
		if (!dims) {
			return err(c, 'INVALID_ATTACHMENT', 'Could not read image dimensions', 400);
		}
		if (dims.width > PROJECT_ICON_MAX_DIMENSION || dims.height > PROJECT_ICON_MAX_DIMENSION) {
			return err(
				c,
				'INVALID_ATTACHMENT',
				`Image exceeds ${PROJECT_ICON_MAX_DIMENSION}×${PROJECT_ICON_MAX_DIMENSION} pixels`,
				400,
			);
		}

		const updated = await db.query<{ updated_at: string }>(
			`INSERT INTO user_icons (user_id, content_type, data, byte_size, width, height, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now())
			 ON CONFLICT (user_id) DO UPDATE SET
			   content_type = EXCLUDED.content_type,
			   data         = EXCLUDED.data,
			   byte_size    = EXCLUDED.byte_size,
			   width        = EXCLUDED.width,
			   height       = EXCLUDED.height,
			   updated_at   = now()
			 RETURNING updated_at`,
			[userId, contentType, buf, buf.byteLength, dims.width, dims.height],
		);

		const version = Math.floor(new Date(updated.rows[0].updated_at).getTime() / 1000);
		const iconUrl = await signEntityIconUrl(
			USER_ICON_BASE_PATH,
			USER_ICON_KEY_PURPOSE,
			userId,
			c.get('masterKeyManager'),
			version,
		);
		return ok(c, { icon_url: iconUrl, icon_updated_at: updated.rows[0].updated_at });
	},
);

usersRoutes.delete('/users/:userId/icon', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const userId = c.req.param('userId');
	await db.query('DELETE FROM user_icons WHERE user_id = $1', [userId]);
	return ok(c, { icon_url: null, icon_updated_at: null });
});

// Public signed-URL read endpoint for a user avatar. Rendered in an `<img>` tag,
// which can't carry a bearer token, so the HMAC `sig` query param is the
// credential. Must be mounted before the `/api/*` auth middleware.
export const publicUsersRoutes = new Hono<Env>();

publicUsersRoutes.get('/api/users/:userId/icon', async (c) => {
	const userId = c.req.param('userId');
	const expRaw = c.req.query('exp');
	const sig = c.req.query('sig');
	if (!expRaw || !sig) {
		return err(c, 'UNAUTHORIZED', 'Missing signature', 401);
	}
	const exp = Number.parseInt(expRaw, 10);
	const masterKeyManager = c.get('masterKeyManager');
	const valid = await verifyEntityIconUrl(
		USER_ICON_KEY_PURPOSE,
		userId,
		exp,
		sig,
		masterKeyManager,
	);
	if (!valid) {
		return err(c, 'UNAUTHORIZED', 'Invalid or expired signature', 401);
	}

	const row = await c.get('db').query<{
		content_type: string;
		data: Uint8Array;
		updated_at: string;
	}>('SELECT content_type, data, updated_at FROM user_icons WHERE user_id = $1', [userId]);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Icon not found', 404);
	}
	const { content_type, data, updated_at } = row.rows[0];
	const src = data instanceof Uint8Array ? data : new Uint8Array(data);
	// Copy into a fresh ArrayBuffer so the body type is Uint8Array<ArrayBuffer>
	// (PGlite hands back a Uint8Array<ArrayBufferLike>).
	const ab = new ArrayBuffer(src.byteLength);
	new Uint8Array(ab).set(src);

	return c.body(new Uint8Array(ab), 200, {
		'Content-Type': content_type,
		'Content-Length': String(src.byteLength),
		'Cache-Control': 'private, max-age=3600',
		ETag: `"${new Date(updated_at).getTime()}"`,
	});
});

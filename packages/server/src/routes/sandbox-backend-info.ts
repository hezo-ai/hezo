import { isSandboxBackend, SANDBOX_BACKENDS, sandboxBackendNeedsApiKey } from '@hezo/shared';
import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import { err, ok } from '../lib/response';
import { isPinned } from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import { hasDaytonaApiKey, readDaytonaApiKey } from '../services/sandbox/backend-store';
import { SandboxBackendError } from '../services/sandbox/errors';
import type { SandboxBackendHolder } from '../services/sandbox/holder';
import { describeSwitchImpact, switchSandboxBackend } from '../services/sandbox/switch-backend';

/**
 * Read and change which container backend the instance runs on. Superuser-only:
 * even redacted, the provider endpoint is infrastructure detail, and the write
 * side destroys every running container.
 *
 * **This used to be read-only**, on the reasoning that the backend was
 * deployment configuration chosen once at startup and never changed. It is now a
 * setting: the launch flag seeds a fresh instance, the stored choice wins from
 * then on, and switching back to local Docker is always available and needs no
 * credential.
 *
 * The API key is written into the vault and never read back out to a client.
 * `credential_configured` says only whether one is on file, which is all the form
 * needs to choose between "enter a key" and "keep the saved one". The endpoint
 * stays pre-redacted server-side (`redactSandboxApiUrl`), so no handler here or
 * later can echo the secret.
 */
export function buildSandboxBackendInfoRoutes(holder: SandboxBackendHolder): Hono<Env> {
	const routes = new Hono<Env>();

	routes.get('/sandbox-backend-info', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		return ok(c, {
			...holder.info,
			available: SANDBOX_BACKENDS,
			credential_configured: await hasDaytonaApiKey(db),
			// So the page renders a locked control rather than inferring that a
			// switch which keeps failing is somehow special.
			backend_pinned: isPinned('backend'),
			// What a switch would cost right now, so the confirmation dialog names
			// real numbers instead of warning in the abstract.
			impact: await describeSwitchImpact(db, holder.engine, c.get('dataDir')),
		});
	});

	routes.patch('/sandbox-backend', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;

		const body = await c.req
			.json<{ backend?: string; daytona_api_key?: string; daytona_api_url?: string }>()
			.catch(() => ({}) as Record<string, never>);

		const target = (body.backend ?? '').trim().toLowerCase();
		if (!isSandboxBackend(target)) {
			return err(
				c,
				'INVALID_REQUEST',
				`backend must be one of: ${SANDBOX_BACKENDS.join(', ')}`,
				400,
			);
		}

		// Refused, never silently ignored. Whoever runs this instance is still its
		// superuser and can call this endpoint directly, so a switch that appeared
		// to succeed and changed nothing would be the worst of both. 409 because
		// the request is authorized and conflicts with a decision made above it.
		const policy = runtimeConfig().policy;
		if (policy && isPinned('backend')) {
			return err(
				c,
				'CONFLICT',
				`The container backend is set by ${policy.managedBy} and cannot be changed here.`,
				409,
			);
		}

		const db = c.get('db');
		const masterKeyManager = c.get('masterKeyManager');

		// Refused before the preflight rather than surfacing as an opaque
		// connection error: a missing credential is a configuration mistake and the
		// message should say which.
		//
		// Gated on the backend's kind rather than its name - every remote container
		// service is reached with an account credential - so a second provider
		// cannot silently skip the check by not being the one named here.
		if (
			sandboxBackendNeedsApiKey(target) &&
			!body.daytona_api_key?.trim() &&
			!(await hasDaytonaApiKey(db))
		) {
			return err(
				c,
				'CREDENTIAL_REQUIRED',
				'That container service needs an API key. Enter one to switch to it.',
				400,
			);
		}

		try {
			const result = await switchSandboxBackend(
				db,
				masterKeyManager,
				holder,
				{
					backend: target,
					daytonaApiKey: body.daytona_api_key,
					daytonaApiUrl: body.daytona_api_url,
				},
				() => readDaytonaApiKey(db, masterKeyManager),
				c.get('dataDir'),
			);
			return ok(c, {
				...holder.info,
				available: SANDBOX_BACKENDS,
				credential_configured: await hasDaytonaApiKey(db),
				containers_destroyed: result.containersDestroyed,
				impact: await describeSwitchImpact(db, holder.engine, c.get('dataDir')),
			});
		} catch (e) {
			if (e instanceof SandboxBackendError) {
				// Nothing was destroyed: the preflight runs first precisely so a failed
				// switch leaves the instance exactly as it was.
				return err(c, 'BACKEND_UNREACHABLE', e.message, 503);
			}
			throw e;
		}
	});

	return routes;
}

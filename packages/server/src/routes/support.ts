import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const supportRoutes = new Hono<Env>();

/**
 * The support channel the deployer runs, for the account that owns this instance.
 *
 * **The owner is the superuser, and only on an instance with an issuer.** An
 * issuer signs in exactly one subject and maps it to the superuser, and it
 * disables every other way to get a session, so a superuser session there is the
 * owner's. Without an issuer there is no issuer-side account for the identity to
 * belong to.
 *
 * **404 for everyone else, and for everyone when nothing is configured.** The
 * identity lets its holder write as the owner, so a caller who may not have it
 * learns nothing, not even that a channel exists.
 *
 * Read on every request rather than at mount, so a policy file rewritten while
 * the instance runs changes the answer with no restart. No MCP twin: an agent
 * has no use for a chat window a person opens.
 */
supportRoutes.get('/support', (c) => {
	const config = runtimeConfig();
	const chatwoot = config.policy?.support?.chatwoot;
	const auth = c.get('auth');
	const isOwner = !!config.sso && auth.type === AuthType.Admin && auth.isSuperuser;
	if (!chatwoot || !isOwner) return err(c, 'NOT_FOUND', 'Not found', 404);

	return ok(c, {
		chatwoot: {
			base_url: chatwoot.baseUrl,
			website_token: chatwoot.websiteToken,
			sdk_integrity: chatwoot.sdkIntegrity,
			identifier: chatwoot.identifier,
			identifier_hash: chatwoot.identifierHash,
			name: chatwoot.name ?? null,
			email: chatwoot.email ?? null,
		},
	});
});

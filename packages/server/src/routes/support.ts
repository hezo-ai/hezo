import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import { isHostedOwner } from '../lib/hosted-owner';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const supportRoutes = new Hono<Env>();

/**
 * The support channel the deployer runs, for the account that owns this instance.
 *
 * **The owner only** (`isHostedOwner`): the superuser, on an instance with an
 * issuer.
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
	const chatwoot = runtimeConfig().policy?.support?.chatwoot;
	if (!chatwoot || !isHostedOwner(c.get('auth'))) return err(c, 'NOT_FOUND', 'Not found', 404);

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

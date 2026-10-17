import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import { isHostedOwner } from '../lib/hosted-owner';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const analyticsRoutes = new Hono<Env>();

/**
 * The product analytics the deployer runs, for the account that owns this
 * instance: where the scripts are, which website counts the visits, who the
 * owner is to it, and whether this account is recorded.
 *
 * **The owner only** (`isHostedOwner`), and **404 for everyone else and for
 * everyone when nothing is configured**, as `GET /api/support` answers. The
 * distinct id is the owner's account, so a caller who may not have it learns
 * nothing, not even that analytics exist. Nothing of it rides the public status
 * either: nothing is collected before the owner has signed in.
 *
 * Read on every request rather than at mount, so a policy file rewritten while
 * the instance runs changes the answer with no restart. No MCP twin: an agent
 * has no use for the scripts a person's browser loads.
 */
analyticsRoutes.get('/analytics', (c) => {
	const umami = runtimeConfig().policy?.analytics?.umami;
	if (!umami || !isHostedOwner(c.get('auth'))) return err(c, 'NOT_FOUND', 'Not found', 404);

	return ok(c, {
		umami: {
			host: umami.host,
			website_id: umami.websiteId,
			distinct_id: umami.distinctId,
			replay: umami.replay
				? { sample_rate: umami.replay.sampleRate, show_text: umami.replay.showText }
				: null,
		},
	});
});

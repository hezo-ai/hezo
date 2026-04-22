import {
	AiAuthMethod,
	type AiProvider,
	ALL_AI_PROVIDERS,
	ApprovalStatus,
	ApprovalType,
	OAUTH_CALLBACK_PATH,
	PlatformType,
} from '@hezo/shared';
import { Hono } from 'hono';
import { verifyOAuthState } from '../crypto/state';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { storeAiProviderKey } from '../services/ai-provider-keys';
import { registerSSHKeyOnGitHub } from '../services/github';
import { enqueueOAuthVerificationTask } from '../services/oauth-verification-tasks';
import { generateCompanySSHKey, getCompanySSHKey, updateGitHubKeyId } from '../services/ssh-keys';
import { storeOAuthToken } from '../services/token-store';

const log = logger.child('routes');

const AI_PROVIDER_PLATFORMS = new Set<string>(ALL_AI_PROVIDERS);

export const oauthCallbackRoutes = new Hono<Env>();

oauthCallbackRoutes.get(OAUTH_CALLBACK_PATH, async (c) => {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const connectUrl = c.get('connectUrl');
	const webUrl = c.get('webUrl');

	const redirect = (path: string) => c.redirect(webUrl ? `${webUrl}${path}` : path);

	const error = c.req.query('error');
	const platform = c.req.query('platform');
	const state = c.req.query('state');

	if (error) {
		const message = c.req.query('message') || error;
		return redirect(`/error?message=${encodeURIComponent(message)}`);
	}

	if (!state || !platform) {
		return c.json(
			{ error: { code: 'BAD_REQUEST', message: 'Missing state or platform parameter' } },
			400,
		);
	}

	const statePayload = await verifyOAuthState(state, masterKeyManager);
	if (!statePayload) {
		return c.json(
			{ error: { code: 'BAD_REQUEST', message: 'Invalid or tampered state parameter' } },
			400,
		);
	}

	const companyId = statePayload.company_id;
	const isAiProvider = AI_PROVIDER_PLATFORMS.has(platform);

	if (!isAiProvider && !companyId) {
		return c.json(
			{ error: { code: 'BAD_REQUEST', message: 'State missing company_id for platform flow' } },
			400,
		);
	}

	// Exchange the one-time code for the actual token via Connect service
	const exchangeCodeParam = c.req.query('code');
	if (!exchangeCodeParam) {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing code parameter' } }, 400);
	}

	if (!connectUrl) {
		return c.json(
			{ error: { code: 'CONNECT_UNAVAILABLE', message: 'Hezo Connect URL is not configured' } },
			503,
		);
	}

	let accessToken: string;
	let scopes: string;
	let metadata: Record<string, unknown> = {};

	try {
		const exchangeRes = await fetch(`${connectUrl}/auth/exchange`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: exchangeCodeParam }),
		});

		if (!exchangeRes.ok) {
			const errBody = await exchangeRes.json().catch(() => null);
			const msg = (errBody as Record<string, string>)?.message || 'Token exchange failed';
			return redirect(`/error?message=${encodeURIComponent(msg)}`);
		}

		const exchangeData = (await exchangeRes.json()) as {
			access_token: string;
			scopes: string;
			metadata: string;
			platform: string;
		};
		accessToken = exchangeData.access_token;
		scopes = exchangeData.scopes || '';

		if (exchangeData.metadata) {
			try {
				metadata = JSON.parse(Buffer.from(exchangeData.metadata, 'base64url').toString('utf8'));
			} catch {
				// Invalid metadata is non-fatal
			}
		}
	} catch {
		return redirect(
			`/error?message=${encodeURIComponent('Failed to exchange token with Connect service')}`,
		);
	}

	// For AI provider platforms, store as ai_provider_config with oauth_token auth method
	if (isAiProvider) {
		try {
			await storeAiProviderKey(
				db,
				masterKeyManager,
				platform as AiProvider,
				accessToken,
				AiAuthMethod.OAuthToken,
				metadata.email ? `${platform} (${metadata.email})` : platform,
				metadata,
			);
		} catch (e) {
			log.warn('AI provider config creation failed:', e instanceof Error ? e.message : e);
		}

		return redirect(`/settings/ai-providers?ai_provider_connected=${platform}`);
	}

	if (!companyId) {
		return c.json(
			{ error: { code: 'BAD_REQUEST', message: 'State missing company_id for platform flow' } },
			400,
		);
	}

	await storeOAuthToken(
		db,
		masterKeyManager,
		companyId,
		platform as PlatformType,
		accessToken,
		scopes,
		metadata,
	);

	if (platform === PlatformType.GitHub) {
		try {
			const existingKey = await getCompanySSHKey(db, companyId, masterKeyManager);
			if (existingKey?.githubKeyId) {
				log.debug(`SSH key already registered on GitHub for company ${companyId} — skipping`);
			} else {
				let publicKey: string;
				if (existingKey) {
					publicKey = existingKey.publicKey;
				} else {
					const generated = await generateCompanySSHKey(db, companyId, masterKeyManager);
					publicKey = generated.publicKey;
				}
				const { id: githubKeyId } = await registerSSHKeyOnGitHub(
					publicKey,
					`hezo-${companyId}`,
					accessToken,
				);
				await updateGitHubKeyId(db, companyId, githubKeyId);
			}
		} catch (err) {
			log.warn('SSH key registration failed:', err instanceof Error ? err.message : err);
		}
	}

	await db.query(
		`UPDATE approvals SET status = $1::approval_status, resolution_note = 'Auto-resolved: platform connected', resolved_at = now()
		 WHERE company_id = $2 AND type = $3::approval_type AND status = $4::approval_status
		   AND payload->>'platform' = $5`,
		[
			ApprovalStatus.Approved,
			companyId,
			ApprovalType.OauthRequest,
			ApprovalStatus.Pending,
			platform,
		],
	);

	const slugResult = await db.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
		companyId,
	]);
	const companyRef = slugResult.rows[0]?.slug ?? companyId;

	try {
		const verification = await enqueueOAuthVerificationTask(
			db,
			companyId,
			platform as PlatformType,
			statePayload.issue_id ?? null,
			metadata,
			c.get('wsManager'),
		);
		if (verification) {
			return redirect(`/companies/${companyRef}/issues/${verification.identifier}`);
		}
	} catch (e) {
		log.warn('Failed to create OAuth verification task:', e instanceof Error ? e.message : e);
	}

	return redirect(`/companies/${companyRef}/settings?connected=${platform}`);
});

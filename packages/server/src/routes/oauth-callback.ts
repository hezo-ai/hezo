import { ApprovalStatus, ApprovalType, PlatformType } from '@hezo/shared';
import { Hono } from 'hono';
import { verifyOAuthState } from '../crypto/state';
import type { Env } from '../lib/types';
import { registerSSHKeyOnGitHub } from '../services/github';
import { generateCompanySSHKey, getCompanySSHKey, updateGitHubKeyId } from '../services/ssh-keys';
import { storeOAuthToken } from '../services/token-store';

export const oauthCallbackRoutes = new Hono<Env>();

oauthCallbackRoutes.get('/oauth/callback', async (c) => {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const error = c.req.query('error');
	const platform = c.req.query('platform');
	const state = c.req.query('state');

	if (error) {
		const message = c.req.query('message') || error;
		return c.redirect(`/error?message=${encodeURIComponent(message)}`);
	}

	if (!state || !platform) {
		return c.text('Missing state or platform parameter', 400);
	}

	const statePayload = await verifyOAuthState(state, masterKeyManager);
	if (!statePayload) {
		return c.text('Invalid or tampered state parameter', 400);
	}

	const companyId = statePayload.company_id;
	const accessToken = c.req.query('access_token');
	const scopes = c.req.query('scopes') || '';
	const metadataParam = c.req.query('metadata');

	if (!accessToken) {
		return c.text('Missing access_token parameter', 400);
	}

	let metadata: Record<string, unknown> = {};
	if (metadataParam) {
		try {
			metadata = JSON.parse(Buffer.from(metadataParam, 'base64url').toString('utf8'));
		} catch {
			// Invalid metadata is non-fatal
		}
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
			let sshKey = await getCompanySSHKey(db, companyId, masterKeyManager);
			if (!sshKey) {
				const generated = await generateCompanySSHKey(db, companyId, masterKeyManager);
				sshKey = { publicKey: generated.publicKey, privateKey: '', githubKeyId: null };
			}
			if (!sshKey.githubKeyId) {
				const { id: githubKeyId } = await registerSSHKeyOnGitHub(
					sshKey.publicKey,
					`hezo-${companyId}`,
					accessToken,
				);
				await updateGitHubKeyId(db, companyId, githubKeyId);
			}
		} catch (err) {
			console.warn('SSH key registration failed:', err instanceof Error ? err.message : err);
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

	return c.redirect(`/companies/${companyId}/settings?connected=${platform}`);
});

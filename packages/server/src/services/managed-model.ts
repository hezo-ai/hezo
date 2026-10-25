/**
 * The managed provider's one credential row, kept in step with the hosted config.
 *
 * A hosting control plane writes `managedModel` beside the held master key, and
 * every boot makes the row match it: inserted when absent, rewritten only where
 * it differs, and removed when the block is. Nobody edits the row by hand (the
 * routes refuse), so the config is its only source.
 */

import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
import type { ManagedModelConfig } from '../config/types';
import { decrypt, encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { withTransaction } from '../lib/sql';
import {
	deleteAiProviderConfig,
	readConfigBaseUrl,
	readConfigRequestHeaders,
} from './ai-provider-keys';

const MANAGED_PROVIDER = AiProvider.HezoCloud;
const MANAGED_LABEL = AI_PROVIDER_INFO[MANAGED_PROVIDER].name;

interface ManagedRow {
	id: string;
	label: string;
	auth_method: string;
	status: string;
	encrypted_credential: string;
	default_model: string | null;
	runtime: string | null;
	metadata: Record<string, unknown> | null;
}

/** The metadata a managed row carries: its endpoint and its request headers. */
function managedMetadata(managed: ManagedModelConfig): Record<string, unknown> {
	return Object.keys(managed.requestHeaders).length > 0
		? { base_url: managed.baseUrl, request_headers: managed.requestHeaders }
		: { base_url: managed.baseUrl };
}

function sameHeaders(
	a: Readonly<Record<string, string>> | null,
	b: Readonly<Record<string, string>>,
): boolean {
	const left = Object.entries(a ?? {});
	return left.length === Object.keys(b).length && left.every(([name, value]) => b[name] === value);
}

/**
 * Make the managed row match the hosted config, or remove it when the config
 * provides none.
 *
 * A new row becomes the default only when no row is, so a tenant who made their
 * own credential the default keeps it. A changed key starts unheld, as any
 * replacement credential does: a hold belongs to the key that was refused.
 * Removal goes through the ordinary delete, which hands a held default on.
 */
export async function syncManagedModel(
	db: Db,
	masterKeyManager: MasterKeyManager,
	managed: ManagedModelConfig | null,
): Promise<void> {
	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) throw new Error('Master key not available');

	const existing = await db.query<ManagedRow>(
		`SELECT id, label, auth_method, status, encrypted_credential, default_model, runtime, metadata
		   FROM ai_provider_configs
		  WHERE provider = $1::ai_provider
		  ORDER BY created_at ASC, id ASC`,
		[MANAGED_PROVIDER],
	);

	if (!managed) {
		for (const row of existing.rows) await deleteAiProviderConfig(db, row.id);
		return;
	}

	const [row, ...extra] = existing.rows;
	for (const stray of extra) await deleteAiProviderConfig(db, stray.id);

	if (!row) {
		await withTransaction(db, async () => {
			await db.query(
				`INSERT INTO ai_provider_configs
				   (provider, auth_method, label, encrypted_credential, is_default, metadata, default_model, status)
				 VALUES ($1::ai_provider, $2::ai_auth_method, $3, $4,
				         NOT EXISTS (SELECT 1 FROM ai_provider_configs WHERE is_default),
				         $5::jsonb, $6, $7)`,
				[
					MANAGED_PROVIDER,
					AiAuthMethod.ApiKey,
					MANAGED_LABEL,
					encrypt(managed.apiKey, encryptionKey),
					JSON.stringify(managedMetadata(managed)),
					managed.model,
					AiProviderStatus.Verified,
				],
			);
		});
		return;
	}

	const keyChanged = decrypt(row.encrypted_credential, encryptionKey) !== managed.apiKey;
	const unchanged =
		!keyChanged &&
		row.label === MANAGED_LABEL &&
		row.auth_method === AiAuthMethod.ApiKey &&
		row.status === AiProviderStatus.Verified &&
		row.default_model === managed.model &&
		row.runtime === null &&
		readConfigBaseUrl(row.metadata) === managed.baseUrl &&
		sameHeaders(readConfigRequestHeaders(row.metadata), managed.requestHeaders) &&
		Object.keys(row.metadata ?? {}).length === Object.keys(managedMetadata(managed)).length;
	if (unchanged) return;

	await db.query(
		`UPDATE ai_provider_configs
		    SET label = $2, auth_method = $3::ai_auth_method, status = $4, default_model = $5,
		        runtime = NULL, metadata = $6::jsonb,
		        encrypted_credential = CASE WHEN $7::boolean THEN $8 ELSE encrypted_credential END,
		        usage_limited_until = CASE WHEN $7::boolean THEN NULL ELSE usage_limited_until END,
		        updated_at = now()
		  WHERE id = $1`,
		[
			row.id,
			MANAGED_LABEL,
			AiAuthMethod.ApiKey,
			AiProviderStatus.Verified,
			managed.model,
			JSON.stringify(managedMetadata(managed)),
			keyChanged,
			keyChanged ? encrypt(managed.apiKey, encryptionKey) : null,
		],
	);
}

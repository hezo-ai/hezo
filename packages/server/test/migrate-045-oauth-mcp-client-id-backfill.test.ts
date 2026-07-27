import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '045_oauth_mcp_client_id_backfill.sql';

interface MetadataRow {
	metadata: Record<string, unknown>;
}

/**
 * The auth-code / DCR callbacks persisted token_url but not client_id, leaving the
 * generic host-side refresh unable to run. The migration recovers the client id
 * from the connector's cached DCR registration. Three shapes have to be right:
 * the broken row is repaired, an already-correct row is not rewritten, and a row
 * with no DCR registration to recover from is left alone rather than getting a
 * null client_id (which would still fail the refresh, but noisily and wrongly).
 */
describe('045_oauth_mcp_client_id_backfill migration', () => {
	let h: DataPreservationHarness;
	let brokenId: string;
	let alreadySetId: string;
	let noDcrId: string;

	async function seedConnection(
		provider: string,
		metadata: Record<string, unknown>,
	): Promise<string> {
		const secret = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ($1, 'enc') RETURNING id`,
			[`OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`],
		);
		const conn = await h.db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label, access_token_secret_id, metadata)
			 VALUES ($1, $2, $3, $4, $5::jsonb)
			 RETURNING id`,
			[provider, `${provider}:acct`, provider, secret.rows[0].id, JSON.stringify(metadata)],
		);
		return conn.rows[0].id;
	}

	async function seedConnector(
		name: string,
		config: Record<string, unknown>,
		oauthConnectionId: string,
	): Promise<void> {
		await h.db.query(
			`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id)
			 VALUES ($1, 'saas', $2::jsonb, $3)`,
			[name, JSON.stringify(config), oauthConnectionId],
		);
	}

	async function metadataOf(id: string): Promise<Record<string, unknown>> {
		const r = await h.db.query<MetadataRow>(
			`SELECT metadata FROM oauth_connections WHERE id = $1`,
			[id],
		);
		return r.rows[0].metadata;
	}

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// The bug: token_url present, client_id missing, DCR registration cached.
		brokenId = await seedConnection('mcp:broken', {
			resource_url: 'https://mcp.example.com/mcp',
			token_url: 'https://auth.example.com/token',
			authorize_url: 'https://auth.example.com/authorize',
		});
		await seedConnector(
			'broken-connector',
			{ url: 'https://mcp.example.com/mcp', dcr: { client_id: 'dcr-client-recovered' } },
			brokenId,
		);

		// Control: a device-flow style connection that already recorded its client id.
		alreadySetId = await seedConnection('mcp:already-set', {
			token_url: 'https://auth.example.com/token',
			client_id: 'original-client-id',
		});
		await seedConnector(
			'already-set-connector',
			{ url: 'https://other.example.com/mcp', dcr: { client_id: 'dcr-should-not-win' } },
			alreadySetId,
		);

		// Control: nothing to recover from.
		noDcrId = await seedConnection('mcp:no-dcr', {
			token_url: 'https://auth.example.com/token',
		});
		await seedConnector('no-dcr-connector', { url: 'https://third.example.com/mcp' }, noDcrId);

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('backfills client_id from the connector DCR registration', async () => {
		expect((await metadataOf(brokenId)).client_id).toBe('dcr-client-recovered');
	});

	it('preserves the other metadata keys on the repaired row', async () => {
		const metadata = await metadataOf(brokenId);
		expect(metadata.resource_url).toBe('https://mcp.example.com/mcp');
		expect(metadata.token_url).toBe('https://auth.example.com/token');
		expect(metadata.authorize_url).toBe('https://auth.example.com/authorize');
	});

	it('leaves an existing client_id untouched', async () => {
		expect((await metadataOf(alreadySetId)).client_id).toBe('original-client-id');
	});

	it('does not write a null client_id when there is no DCR registration', async () => {
		const metadata = await metadataOf(noDcrId);
		expect('client_id' in metadata).toBe(false);
		expect(metadata.token_url).toBe('https://auth.example.com/token');
	});

	it('preserves every pre-existing row and its connector link', async () => {
		const rows = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM oauth_connections WHERE id = ANY($1::uuid[])`,
			[[brokenId, alreadySetId, noDcrId]],
		);
		expect(rows.rows[0].c).toBe(3);
		const links = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM mcp_connections WHERE oauth_connection_id IS NOT NULL`,
		);
		expect(links.rows[0].c).toBe(3);
	});
});

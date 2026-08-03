/**
 * Egress-proxy conformance: the red line, asserted end to end on a real backend.
 *
 * The invariant is that **an agent never holds a secret's value** - it writes
 * `__HEZO_SECRET_<NAME>__` and the egress proxy substitutes the real value at
 * request time, outside the container. Everything about *deciding* to substitute
 * is host-side and backend-agnostic, and `egress-substitution.test.ts` and
 * `test/bun/egress-proxy.bun.test.ts` already pin it.
 *
 * What is **not** backend-agnostic is whether a request made inside a container
 * reaches that proxy at all. That path is the adapter's byte channel carrying a
 * multiplexed CONNECT, the in-container client's split-routing decision, and the
 * image's trust store accepting the MITM leaf - three things that differ per
 * backend and all of which fail the same silent way: the request goes out
 * *direct*, unsubstituted, and the agent gets a 401 from the provider with
 * nothing naming the cause. A wildcard-syntax mismatch between the proxy and the
 * tunnel did exactly that, and no host-side test could have seen it.
 *
 * So this suite asserts the whole chain on whichever backend it is pointed at:
 *
 * 1. a placeholder written inside the container comes back **substituted** at
 *    the upstream, and
 * 2. the real value is nowhere the container could have read it, and
 * 3. a host the secret is not scoped to gets the **placeholder**, not the value.
 *
 * (3) is the fail-closed half and matters as much as (1): the proxy refusing a
 * host must degrade to a useless credential, never to a leaked one.
 *
 * Generic like its siblings - a new adapter (Modal, E2B, …) is a fixture entry,
 * not another copy of this file. It needs nothing from the fixture beyond a
 * `ContainerEngine` and the run user, so a backend that can exec and write files
 * can run it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt } from '../../src/crypto/encryption';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import type { Db } from '../../src/db/database';
import { type HezoCA, loadOrCreateCA } from '../../src/services/egress/ca';
import { EgressProxy } from '../../src/services/egress/proxy';
import { invalidateSecretsVault } from '../../src/services/egress/substitution';
import { type RunTunnel, startRunTunnel } from '../../src/services/sandbox/tunnel/run-tunnel';
import { createTestApp, createTestProject, createTestTeam } from '../helpers/app';
import { mintCertFromCA } from '../helpers/self-signed-cert';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	sweepConformanceContainers,
} from './fixture';

/** The value that must never appear inside the container, in any form. */
const SECRET_VALUE = 'conformance-real-secret-value';
const SECRET_NAME = 'CONFORMANCE_EGRESS_TOKEN';
const PLACEHOLDER = `__HEZO_SECRET_${SECRET_NAME}__`;

/** Where the CA lands in the container, matching what provisioning uses. */
const CONTAINER_CA_PATH = '/usr/local/share/ca-certificates/hezo-egress.crt';

interface UpstreamHit {
	path: string;
	authorization: string | undefined;
}

/** Registers the egress-substitution conformance suite for one backend. */
export function describeEgressConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	describe(`${fixture.name}: egress secret substitution conformance`, () => {
		const engine = fixture.engine;
		const hits: UpstreamHit[] = [];
		let containerId = '';
		let db: Db;
		let masterKeyManager: MasterKeyManager;
		let closeApp: (() => Promise<void>) | null = null;
		let ca: HezoCA;
		let caDir = '';
		let upstream: HttpsServer | null = null;
		let upstreamPort = 0;
		let proxy: EgressProxy | null = null;
		let tunnel: RunTunnel | null = null;
		let proxyUrl = '';
		const runId = `conf-egress-${conformanceRunId()}`;

		beforeAll(async () => {
			await sweepConformanceContainers(engine);

			const ctx = await createTestApp();
			db = ctx.db;
			masterKeyManager = ctx.masterKeyManager;
			closeApp = () => ctx.db.close();
			const team = (await (await createTestTeam(ctx.db, { name: 'Egress Conformance' })).json())
				.data;
			const projectSlug = (
				await (await createTestProject(ctx.db, team.id, { name: 'Egress Conformance' })).json()
			).data.slug;
			const agent = (
				await (
					await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
						method: 'POST',
						headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
						body: JSON.stringify({ title: 'Egress Conformance Agent' }),
					})
				).json()
			).data;

			caDir = mkdtempSync(join(tmpdir(), 'hezo-conf-egress-'));
			ca = await loadOrCreateCA(caDir);

			// Stands in for a third-party API. It is on the **host**, reached by the
			// proxy (also on the host) - the container only ever names it. Signed by
			// the same CA the proxy trusts upstream, which is how a self-contained
			// test gets a verifiable TLS peer.
			const { cert, key } = await mintCertFromCA(ca, 'localhost');
			upstream = createHttpsServer({ cert, key }, (req, res) => {
				hits.push({
					path: req.url ?? '',
					authorization: req.headers.authorization as string | undefined,
				});
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true }));
			});
			await new Promise<void>((resolve) =>
				(upstream as HttpsServer).listen(0, '127.0.0.1', () => resolve()),
			);
			upstreamPort = (upstream.address() as { port: number }).port;

			// Scoped to `localhost` only. The second test names a host outside this
			// list and must come back unsubstituted.
			await insertSecret(db, masterKeyManager, SECRET_NAME, SECRET_VALUE, ['localhost']);

			proxy = new EgressProxy({
				db,
				masterKeyManager,
				ca,
				// The upstream's leaf is CA-signed rather than publicly trusted; this
				// is what lets the proxy verify it. Production trusts the real world.
				extraUpstreamTrustedCAs: ca.cert,
				authEnabled: true,
			});
			const allocated = await proxy.allocateRunProxy(runId, {
				teamId: team.id,
				agentId: agent.id,
			});

			const created = await engine.createContainer(`hezo-conf-egress-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);

			// The image has to carry the tunnel client, and the failure when it does
			// not is a 30-second "did not bind its ports" that reads as a broken
			// tunnel rather than as a missing binary. Refuse up front with the actual
			// reason, the same posture `openSandboxBackend` takes: a precondition
			// this suite cannot satisfy is a failed run, not a quiet skip - a suite
			// that skipped here would report green while asserting nothing about the
			// one path it exists for.
			//
			// It bites on a managed backend before it bites on Docker: Docker builds
			// from this working tree, while a provider pulls a *published* image, so
			// the tunnel is absent there until a build carrying it has been pushed.
			// Point `HEZO_CONFORMANCE_IMAGE` at one built from this branch.
			const probe = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'command -v hezo-tunnel || echo MISSING'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			const probeOut = (await engine.execStart(probe)).stdout;
			if (probeOut.includes('MISSING')) {
				throw new Error(
					`${fixture.name}: the image ${fixture.image} does not carry hezo-tunnel, so no ` +
						'container-to-host path exists to test. Point HEZO_CONFORMANCE_IMAGE at an image ' +
						'built from this branch (docker/Dockerfile.agent-base installs it).',
				);
			}

			// The CA goes into the image's own trust store the way provisioning does
			// it - `SandboxFiles.write` then an elevated `update-ca-certificates` - so
			// this also proves the backend's file seam and elevated exec can put a
			// file where the system trust store reads it. `--cacert` would have been
			// simpler and would have tested less.
			//
			// That claim was **false** when it was first written, and the gap it hid
			// is worth recording: provisioning delivered the CA as a Docker
			// `host:container` bind, which a managed backend cannot honour - Daytona's
			// adapter created the directory and dropped the file. This suite
			// reconstructed the state provisioning failed to produce, so it passed on
			// Daytona while every real run there had `NODE_EXTRA_CA_CERTS` pointing at
			// nothing. Provisioning uses this same seam now (`provisionContainer`),
			// which is what makes the sentence above true; the assertion that it
			// *does* is a unit test on provisioning, because it is a fact about
			// Hezo's code rather than about the backend.
			const caFiles = engine.files(containerId, '/usr/local/share/ca-certificates');
			await caFiles.write('hezo-egress.crt', ca.cert, { mode: 0o644 });
			const install = await engine.execCreate(containerId, {
				Cmd: ['update-ca-certificates'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(install);

			// The tunnel is the piece under test on each backend: the container's
			// only route to the proxy. `mcp`/`ssh` point at the proxy too - nothing
			// here dials them, and a target must exist for the client to start.
			tunnel = await startRunTunnel({
				engine,
				containerId,
				runUser: { name: fixture.runUser, uid: 1000, gid: 1000 },
				files: engine.files(containerId, fixture.workRoot),
				configRelPath: '.hezo/tunnel/egress-conformance.json',
				configContainerPath: `${fixture.workRoot}/.hezo/tunnel/egress-conformance.json`,
				addresses: {
					proxy: { host: allocated.proxyHost, port: allocated.proxyPort },
					mcp: { host: allocated.proxyHost, port: allocated.proxyPort },
					ssh: { host: allocated.proxyHost, port: allocated.proxyPort },
				},
				// `localhost` only, so the third assertion below is about split
				// routing rather than about the proxy's own allowlist.
				policy: { proxiedHosts: ['localhost'], proxyEverything: false },
			});
			const token = allocated.token;
			proxyUrl = `http://run:${token}@127.0.0.1:${tunnel.endpoints.proxyPort}`;
		}, 300_000);

		afterAll(async () => {
			tunnel?.close();
			await proxy?.releaseAll().catch(() => undefined);
			if (upstream) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
			await sweepConformanceContainers(engine);
			await closeApp?.().catch(() => undefined);
			if (caDir) rmSync(caDir, { recursive: true, force: true });
		}, 120_000);

		/** Run curl inside the container as the deprivileged run user. */
		async function curlInContainer(url: string, header: string): Promise<string> {
			const exec = await engine.execCreate(containerId, {
				Cmd: [
					'sh',
					'-c',
					`curl -sS --max-time 20 -o /dev/null -w '%{http_code}' ` +
						`-x ${shellQuote(proxyUrl)} -H ${shellQuote(header)} ${shellQuote(url)} 2>&1`,
				],
				User: fixture.runUser,
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout, stderr } = await engine.execStart(exec);
			return `${stdout}${stderr}`;
		}

		it('substitutes a placeholder the container never held the value for', async () => {
			// The whole red line in one assertion: the agent writes a placeholder,
			// the upstream receives the real credential, and the substitution
			// happened outside the container.
			const before = hits.length;
			const out = await curlInContainer(
				`https://localhost:${upstreamPort}/substituted`,
				`Authorization: Bearer ${PLACEHOLDER}`,
			);
			expect(out).toContain('200');

			const hit = hits.slice(before).find((x) => x.path === '/substituted');
			expect(hit).toBeDefined();
			expect(hit?.authorization).toBe(`Bearer ${SECRET_VALUE}`);
		}, 180_000);

		it('never lets the real value into the container', async () => {
			// The value must exist nowhere a compromised agent could read it. Grepped
			// from *inside*, across the whole filesystem the run can see, because the
			// interesting failure is a value that leaked into a config file or an env
			// var rather than one visible in a response body.
			const exec = await engine.execCreate(containerId, {
				Cmd: [
					'sh',
					'-c',
					// `/proc` is excluded: it would match this grep's own argv.
					`{ cat /proc/1/environ | tr '\\0' '\\n'; ` +
						`grep -rIl ${shellQuote(SECRET_VALUE)} / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; } ` +
						`| grep -F ${shellQuote(SECRET_VALUE)} || echo NOT-PRESENT`,
				],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout } = await engine.execStart(exec);
			expect(stdout).toContain('NOT-PRESENT');
			expect(stdout).not.toContain(SECRET_VALUE);
		}, 180_000);

		it('sends the placeholder unsubstituted to a host the secret is not scoped to', async () => {
			// Fail-closed, and the reason routing anything direct is safe at all: a
			// host outside `allowed_hosts` gets a useless string, never the value.
			// Asserted against a *proxied* host so the refusal is the proxy's own
			// scoping decision rather than an artefact of split routing.
			await insertSecret(db, masterKeyManager, SECRET_NAME, SECRET_VALUE, ['example.invalid']);
			try {
				const before = hits.length;
				await curlInContainer(
					`https://localhost:${upstreamPort}/unscoped`,
					`Authorization: Bearer ${PLACEHOLDER}`,
				);
				const hit = hits.slice(before).find((x) => x.path === '/unscoped');
				// The request may be refused outright or arrive carrying the
				// placeholder; both are fail-closed. What must never happen is the
				// value arriving at a host the secret was not scoped to.
				if (hit) {
					expect(hit.authorization).not.toContain(SECRET_VALUE);
					expect(hit.authorization).toContain(PLACEHOLDER);
				}
			} finally {
				await insertSecret(db, masterKeyManager, SECRET_NAME, SECRET_VALUE, ['localhost']);
			}
		}, 180_000);
	});
}

/**
 * Seed a secret straight into the vault.
 *
 * Raw SQL bypasses the routes that drop the decrypted-vault cache, so the
 * invalidation those routes do has to happen here too - otherwise the third test
 * re-scopes a secret the proxy is still serving from memory.
 */
async function insertSecret(
	db: Db,
	masterKeyManager: MasterKeyManager,
	name: string,
	value: string,
	allowedHosts: string[],
): Promise<void> {
	const key = masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable in the conformance harness');
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token'::secret_category, $3)
		 ON CONFLICT (name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value, allowed_hosts = EXCLUDED.allowed_hosts`,
		[name, encrypt(value, key), allowedHosts],
	);
	invalidateSecretsVault();
}

/** Single-quote for `sh -c`, closing and reopening around any embedded quote. */
function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

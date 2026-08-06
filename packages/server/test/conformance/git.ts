/**
 * Git-transport conformance: can a container on this backend actually clone?
 *
 * **This suite exists because its absence cost real runs.** Git transport was
 * SSH, pinned to `ssh.github.com:443` on the sound-looking reasoning that a
 * managed sandbox allows only 80 and 443 out. Nothing asserted it, so nobody
 * found out that Daytona's egress filters on *protocol*: port 22 is dropped and
 * 443 admits the connection then resets it the moment the payload turns out not
 * to be TLS. Every clone, fetch and push failed there while every host-side test
 * stayed green, because a host-side test can only check the request Hezo builds -
 * never whether the container can carry it.
 *
 * So the two halves are asserted separately, and both matter:
 *
 * 1. **Reach.** A real git host, over the transport Hezo actually builds, from
 *    inside a provisioned container. This is the one that catches a
 *    Daytona-class failure - a backend whose network will not carry the
 *    protocol - and it is why the assertion has to run on the backend rather
 *    than on the host.
 * 2. **Credential.** A clone whose remote carries `__HEZO_SECRET_<NAME>__`
 *    succeeds against a server that demands the real token, and the real token
 *    exists nowhere the container can read. Git base64s a URL credential into
 *    `Authorization: Basic`, so this is the end-to-end proof of the decode/
 *    substitute/re-encode path - a literal placeholder scan sees nothing there,
 *    and the failure mode is a clone that ships the placeholder as its password.
 *
 * **It found two, immediately, and neither was reachable from any other test.**
 * Both were invisible because every other assertion about the proxy drives it
 * with curl, and curl and git differ in ways that turn out to matter:
 *
 * - The proxy answered an unauthenticated CONNECT with a 407 that named no
 *   connection management, then destroyed the socket. curl's `-x user:pass@`
 *   sends Basic on the *first* CONNECT and never sees it; git sets libcurl's
 *   `CURLOPT_PROXYAUTH` to `CURLAUTH_ANY`, so it probes first, then retried down
 *   a socket that was already gone - `Proxy CONNECT aborted`, on every clone.
 * - The proxy gates substitution on a cheap literal scan of the headers, which
 *   cannot see through base64. So `applyToAuthorization`, written for exactly
 *   this credential shape and unit-tested directly, was never called on a real
 *   request: every clone would have shipped the placeholder as its password.
 *
 * The lesson is the one this directory exists for - a host-side test can only
 * check the request Hezo builds, and a test that drives the path with a
 * different client is checking a different path.
 *
 * Generic like its siblings: a new adapter (Modal, E2B, …) is a fixture entry,
 * not another copy of this file. It needs nothing beyond a `ContainerEngine`,
 * the run user, and an image carrying `git` and `hezo-tunnel`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt } from '../../src/crypto/encryption';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import type { Db } from '../../src/db/database';
import type { ContainerRunUser } from '../../src/services/container-user';
import { type HezoCA, loadOrCreateCA } from '../../src/services/egress/ca';
import { EgressProxy } from '../../src/services/egress/proxy';
import { invalidateSecretsVault } from '../../src/services/egress/substitution';
import { ContainerGitExecutor } from '../../src/services/git-executor';
import { type RunTunnel, startRunTunnel } from '../../src/services/sandbox/tunnel/run-tunnel';
import { withProvisionBridge } from '../../src/services/ssh-agent/host';
import { SshAgentServer } from '../../src/services/ssh-agent/server';
import { generateTeamSSHKey } from '../../src/services/ssh-keys';
import { createTestApp, createTestProject, createTestTeam } from '../helpers/app';
import { mintCertFromCA } from '../helpers/self-signed-cert';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	sweepConformanceContainers,
} from './fixture';

const SECRET_NAME = 'CONFORMANCE_GIT_TOKEN';
const SECRET_VALUE = 'conformance-real-git-token';
const PLACEHOLDER = `__HEZO_SECRET_${SECRET_NAME}__`;

/**
 * A tiny, stable public repo for the reach assertion. `ls-remote` fetches only
 * the ref advertisement, so this costs one request and clones nothing.
 */
const PUBLIC_REMOTE = 'https://github.com/octocat/Hello-World.git';

/** The file the served repo contains, so a successful clone is checkable. */
const REPO_FILE = 'conformance.txt';
const REPO_CONTENT = 'cloned through the proxy\n';

/** Registers the git-transport conformance suite for one backend. */
export function describeGitConformance(fixture: LiveAdapterFixture, h: ConformanceHarness): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	describe(`${fixture.name}: git transport conformance`, () => {
		const engine = fixture.engine;
		let containerId = '';
		let db: Db;
		let masterKeyManager: MasterKeyManager;
		let closeApp: (() => Promise<void>) | null = null;
		let ca: HezoCA;
		let workDir = '';
		let server: HttpsServer | null = null;
		let serverPort = 0;
		let proxy: EgressProxy | null = null;
		let tunnel: RunTunnel | null = null;
		let proxyEnv: string[] = [];
		let teamId = '';
		let sshAgentServer: SshAgentServer | null = null;
		let containerRunUser: ContainerRunUser = { name: 'node', uid: 1000, gid: 1000 };
		const runId = `conf-git-${conformanceRunId()}`;

		beforeAll(async () => {
			await sweepConformanceContainers(engine);

			const ctx = await createTestApp();
			db = ctx.db;
			masterKeyManager = ctx.masterKeyManager;
			closeApp = () => ctx.db.close();
			const team = (await (await createTestTeam(ctx.db, { name: 'Git Conformance' })).json()).data;
			teamId = team.id;
			containerRunUser = { name: fixture.runUser, uid: 1000, gid: 1000 };
			const projectSlug = (
				await (await createTestProject(ctx.db, team.id, { name: 'Git Conformance' })).json()
			).data.slug;
			const agent = (
				await (
					await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
						method: 'POST',
						headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
						body: JSON.stringify({ title: 'Git Conformance Agent' }),
					})
				).json()
			).data;

			workDir = mkdtempSync(join(tmpdir(), 'hezo-conf-git-'));
			ca = await loadOrCreateCA(join(workDir, 'ca'));

			// A real repo, served over git's dumb HTTP protocol - which is just
			// static files once `update-server-info` has run. That is enough for
			// `git clone` and needs no git server, so the suite stays self-contained
			// while still exercising git's own HTTP client and its Basic auth.
			const repoDir = buildServedRepo(workDir);

			const { cert, key } = await mintCertFromCA(ca, 'localhost');
			server = createHttpsServer({ cert, key }, (req, res) => {
				// Demands the **real** token. A clone that shipped the unsubstituted
				// placeholder gets a 401 here, which is exactly the failure the
				// Basic-auth substitution exists to prevent.
				const expected = `Basic ${Buffer.from(`x-access-token:${SECRET_VALUE}`).toString('base64')}`;
				if (req.headers.authorization !== expected) {
					res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
					res.end();
					return;
				}
				serveRepoFile(repoDir, req.url ?? '', res);
			});
			await new Promise<void>((resolve) =>
				(server as HttpsServer).listen(0, '127.0.0.1', () => resolve()),
			);
			serverPort = (server.address() as { port: number }).port;

			await insertSecret(db, masterKeyManager, SECRET_NAME, SECRET_VALUE, ['localhost']);

			proxy = new EgressProxy({
				db,
				masterKeyManager,
				ca,
				extraUpstreamTrustedCAs: ca.cert,
				authEnabled: true,
				// The suite's upstream is a throwaway HTTPS server on the host's
				// loopback, which the destination guard refuses by default - correctly,
				// since in production nothing behind a container's tunnel should reach
				// Hezo's own address space. The fixture is the exception, not the rule:
				// production keeps the guard on.
				allowPrivateTargets: true,
			});
			const allocated = await proxy.allocateRunProxy(runId, {
				teamId: team.id,
				agentId: agent.id,
			});

			const created = await engine.createContainer(`hezo-conf-git-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);

			// Both binaries are preconditions this suite cannot satisfy, so a missing
			// one is a failed run with the reason named - never a quiet skip, which
			// would report green while asserting nothing about the only path this
			// file exists for. On a managed backend the image is *pulled*, so point
			// HEZO_CONFORMANCE_IMAGE at one built from this branch.
			await requireBinaries(engine, containerId, fixture, [
				'git',
				'hezo-tunnel',
				// The production seam wraps a remote op in the bridge runner, so a
				// missing one must name itself rather than surface as a git failure.
				'hezo-run-with-bridge',
			]);

			// The production provisioning path allocates its own ssh + egress pair,
			// so the seam leg below needs a server holding the team's key.
			await generateTeamSSHKey(db, team.id, masterKeyManager);
			sshAgentServer = new SshAgentServer({ db, masterKeyManager });

			const caFiles = engine.files(containerId, '/usr/local/share/ca-certificates');
			await caFiles.write('hezo-egress.crt', ca.cert, { mode: 0o644 });
			const install = await engine.execCreate(containerId, {
				Cmd: ['update-ca-certificates'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(install);

			tunnel = await startRunTunnel({
				engine,
				containerId,
				runUser: { name: fixture.runUser, uid: 1000, gid: 1000 },
				files: engine.files(containerId, fixture.workRoot),
				configRelPath: '.hezo/tunnel/git-conformance.json',
				configContainerPath: `${fixture.workRoot}/.hezo/tunnel/git-conformance.json`,
				addresses: {
					proxy: { host: allocated.proxyHost, port: allocated.proxyPort },
					mcp: { host: allocated.proxyHost, port: allocated.proxyPort },
					ssh: { host: allocated.proxyHost, port: allocated.proxyPort },
				},
				// Exactly the egress suite's policy, which is the configuration CI
				// already proves works: split routing with `localhost` proxied. The
				// reach test deliberately runs *outside* the proxy (see below), so
				// nothing here needs `proxyEverything`.
				policy: { proxiedHosts: ['localhost'], proxyEverything: false },
			});
			const url = `http://run:${allocated.token}@127.0.0.1:${tunnel.endpoints.proxyPort}`;
			// Git reads these the way every other HTTP client does, which is the
			// point: nothing git-specific carries a run's traffic to the proxy.
			proxyEnv = [`HTTPS_PROXY=${url}`, `HTTP_PROXY=${url}`, 'GIT_TERMINAL_PROMPT=0'];
		}, 300_000);

		afterAll(async () => {
			tunnel?.close();
			await sshAgentServer?.releaseAll().catch(() => undefined);
			await proxy?.releaseAll().catch(() => undefined);
			if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
			await sweepConformanceContainers(engine);
			await closeApp?.().catch(() => undefined);
			if (workDir) rmSync(workDir, { recursive: true, force: true });
		}, 120_000);

		/** Run a shell command in the container as the deprivileged run user. */
		async function sh(command: string, env: string[] = proxyEnv): Promise<string> {
			const exec = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', command],
				User: fixture.runUser,
				Env: env,
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout, stderr } = await engine.execStart(exec);
			return `${stdout}${stderr}`;
		}

		it('reaches a real git host over the transport Hezo builds', async () => {
			// The Daytona-class assertion, and deliberately the plainest thing in the
			// file: a public repo, no credential, and **no proxy** - `sh` is called
			// with an empty env on purpose. The question is only "can a container on
			// this backend speak git's transport to the outside world", which SSH
			// could not on any port. Routing it through the proxy would answer a
			// different question and drag the MITM's upstream trust of a public CA
			// into an assertion that has nothing to do with it.
			const out = await sh(`git ls-remote --heads ${PUBLIC_REMOTE} 2>&1 | head -5`, []);
			expect(out).toContain('refs/heads/');
			expect(out).not.toContain('kex_exchange_identification');
		}, 180_000);

		it('clones with a credential the container never holds', async () => {
			// End to end: the remote carries a placeholder, git base64s it into a
			// Basic header, the proxy decodes and substitutes outside the container,
			// and the server - which accepts only the real token - serves the repo.
			const remote = `https://x-access-token:${PLACEHOLDER}@localhost:${serverPort}/served.git`;
			const out = await sh(
				`rm -rf /tmp/conf-clone && git clone ${shellQuote(remote)} /tmp/conf-clone 2>&1; ` +
					`cat /tmp/conf-clone/${REPO_FILE} 2>&1`,
			);
			expect(out).toContain(REPO_CONTENT.trim());
			// A 401 here is the regression: the placeholder went out as the password
			// because a literal scan cannot see inside base64.
			expect(out).not.toContain('Authentication failed');
		}, 180_000);

		/**
		 * The same clone, driven by the code production actually runs.
		 *
		 * The legs above hand-build `HTTPS_PROXY` and call `sh` directly, which
		 * proves the *proxy* substitutes for git but says nothing about whether
		 * anything points git at it. That gap shipped: `ContainerGitExecutor` set
		 * no proxy env at all and `withProvisionBridge` pointed its tunnel's proxy
		 * target at port 0, so every private clone connected direct and sent
		 * `__HEZO_SECRET_<NAME>__` as its password - while this file stayed green,
		 * because it was driving a different path with a different client.
		 *
		 * So this leg builds nothing by hand: `withProvisionBridge` allocates the
		 * ssh + egress pair and derives the split-routing policy from the vault,
		 * and `ContainerGitExecutor` runs the clone exactly as provisioning does.
		 */
		it('clones through the production provisioning seam, with nothing hand-wired', async () => {
			const remote = `https://x-access-token:${PLACEHOLDER}@localhost:${serverPort}/served.git`;
			const out = await withProvisionBridge(
				sshAgentServer as SshAgentServer,
				{
					engine,
					containerId,
					teamId,
					dataDir: workDir,
					runUser: containerRunUser,
					db,
					egressProxy: proxy as EgressProxy,
					projectId: null,
				},
				async ({ bridge, scopeId, proxyEnv: seamProxyEnv }) => {
					const executor = ContainerGitExecutor.forPrep(
						engine,
						containerId,
						bridge,
						containerRunUser,
						scopeId,
						seamProxyEnv,
					);
					await executor.exec(['clone', remote, '/tmp/conf-seam-clone'], {
						cwd: '/tmp',
						needsNetwork: true,
						timeout: 120_000,
					});
					// Read the file back through the same executor's container, so a
					// clone that silently produced nothing cannot pass.
					return executor.exec(['--no-pager', 'show', `HEAD:${REPO_FILE}`], {
						cwd: '/tmp/conf-seam-clone',
					});
				},
			);
			expect(`${out.stdout}${out.stderr}`).toContain(REPO_CONTENT.trim());
			expect(out.exitCode).toBe(0);
		}, 300_000);

		it('never lets the real token into the container', async () => {
			// Including the clone's own `.git/config`, which is where a credential in
			// a remote URL is persisted - so this also proves the stored remote keeps
			// the placeholder rather than a substituted value.
			const out = await sh(
				`{ cat /proc/1/environ | tr '\\0' '\\n'; ` +
					`grep -rIl ${shellQuote(SECRET_VALUE)} / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; } ` +
					`| grep -F ${shellQuote(SECRET_VALUE)} || echo CLEAN`,
			);
			expect(out).toContain('CLEAN');

			const config = await sh('cat /tmp/conf-clone/.git/config 2>&1');
			expect(config).toContain(PLACEHOLDER);
			expect(config).not.toContain(SECRET_VALUE);
		}, 180_000);
	});
}

/**
 * A bare repo with one commit, published for git's dumb HTTP protocol.
 *
 * Host git, not the container's: the fixture serves this, it does not test it.
 */
function buildServedRepo(root: string): string {
	const work = join(root, 'work');
	const bare = join(root, 'served.git');
	const git = (args: string[], cwd: string) =>
		execFileSync('git', args, {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'Conformance',
				GIT_AUTHOR_EMAIL: 'conformance@hezo.test',
				GIT_COMMITTER_NAME: 'Conformance',
				GIT_COMMITTER_EMAIL: 'conformance@hezo.test',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			},
		});

	execFileSync('mkdir', ['-p', work]);
	git(['init', '-b', 'main'], work);
	writeFileSync(join(work, REPO_FILE), REPO_CONTENT);
	git(['add', '-A'], work);
	git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'conformance fixture'], work);
	git(['clone', '--bare', work, bare], root);
	// What makes a plain static file server enough for `git clone`.
	git(['update-server-info'], bare);
	return bare;
}

/** Serve one file out of the bare repo, refusing anything outside it. */
function serveRepoFile(
	repoDir: string,
	url: string,
	res: {
		writeHead: (code: number, headers?: Record<string, string>) => void;
		end: (b?: unknown) => void;
	},
): void {
	const rel = decodeURIComponent(url.split('?')[0] ?? '').replace(/^\/served\.git\/?/, '');
	// Path traversal would let a failing test read the host; refuse rather than
	// resolve, since every path this repo serves is a plain relative one.
	if (!rel || rel.includes('..')) {
		res.writeHead(404);
		res.end();
		return;
	}
	try {
		const body = execFileSync('cat', [join(repoDir, rel)]);
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end();
	}
}

/** Fail loudly, naming the binary, rather than skipping a precondition. */
async function requireBinaries(
	engine: LiveAdapterFixture['engine'],
	containerId: string,
	fixture: LiveAdapterFixture,
	binaries: string[],
): Promise<void> {
	for (const bin of binaries) {
		const probe = await engine.execCreate(containerId, {
			Cmd: ['sh', '-c', `command -v ${bin} || echo MISSING`],
			User: 'root',
			AttachStdout: true,
			AttachStderr: true,
		});
		const out = (await engine.execStart(probe)).stdout;
		if (out.includes('MISSING')) {
			throw new Error(
				`${fixture.name}: the image ${fixture.image} does not carry \`${bin}\`, so git transport ` +
					'cannot be tested on this backend. Point HEZO_CONFORMANCE_IMAGE at an image built ' +
					'from this branch (docker/Dockerfile.agent-base installs both).',
			);
		}
	}
}

/** Seed a secret straight into the vault; see the note in `egress.ts`. */
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

import { createServer, type Server } from 'node:http';
import { Hono } from 'hono';

export interface GitHubSimRepo {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
	clone_url: string;
	ssh_url: string;
}

export interface GitHubSimOrg {
	login: string;
	avatar_url: string;
}

export interface GitHubSimUser {
	id: number;
	login: string;
	avatar_url: string;
	email: string | null;
}

export interface DeviceFlowEntry {
	deviceCode: string;
	userCode: string;
	clientId: string;
	scopes: string;
	/** When set to a token, polling resolves with that token. Until then, polling returns authorization_pending. */
	approvedToken: string | null;
	expiresAt: number;
}

export interface SigningKey {
	id: number;
	title: string;
	key: string;
}

export interface GitHubSimState {
	token: string;
	user: GitHubSimUser;
	orgs: GitHubSimOrg[];
	repos: GitHubSimRepo[];
	signingKeys: SigningKey[];
	deviceFlows: Map<string, DeviceFlowEntry>;
	oauthCodes: Map<string, string>;
}

export interface GitHubSim {
	baseUrl: string;
	state: GitHubSimState;
	seed(partial: Partial<Omit<GitHubSimState, 'deviceFlows' | 'oauthCodes'>>): void;
	approveDeviceFlow(userCode: string, accessToken?: string): void;
	addCode(code: string, accessToken?: string): void;
	destroy(): Promise<void>;
}

export async function createGitHubSim(): Promise<GitHubSim> {
	const state: GitHubSimState = {
		token: 'gho_sim_test_token',
		user: { id: 9001, login: 'sim-user', avatar_url: '', email: 'sim@hezo.test' },
		orgs: [],
		repos: [],
		signingKeys: [],
		deviceFlows: new Map(),
		oauthCodes: new Map(),
	};

	let nextRepoId = 10_000;
	let nextSigningKeyId = 200;

	const app = new Hono();

	const isAuthed = (header: string | undefined) =>
		typeof header === 'string' &&
		(header === `Bearer ${state.token}` || header === `token ${state.token}`);

	app.post('/login/device/code', async (c) => {
		const body = await c.req.parseBody();
		const clientId = String(body.client_id ?? '');
		const scopes = String(body.scope ?? '');
		const userCode = `USR-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
		const deviceCode = `dev-${Math.random().toString(36).slice(2, 14)}`;
		state.deviceFlows.set(deviceCode, {
			deviceCode,
			userCode,
			clientId,
			scopes,
			approvedToken: null,
			expiresAt: Date.now() + 900_000,
		});
		return c.json({
			device_code: deviceCode,
			user_code: userCode,
			verification_uri: `${baseUrl}/login/device`,
			expires_in: 900,
			interval: 5,
		});
	});

	app.post('/login/oauth/access_token', async (c) => {
		const body = await c.req.parseBody();
		const grantType = String(body.grant_type ?? '');
		if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
			const deviceCode = String(body.device_code ?? '');
			const flow = state.deviceFlows.get(deviceCode);
			if (!flow) return c.json({ error: 'expired_token' });
			if (flow.expiresAt < Date.now()) return c.json({ error: 'expired_token' });
			if (!flow.approvedToken) return c.json({ error: 'authorization_pending' });
			return c.json({
				access_token: flow.approvedToken,
				token_type: 'bearer',
				scope: flow.scopes,
			});
		}
		const code = String(body.code ?? '');
		const token = state.oauthCodes.get(code) ?? state.token;
		return c.json({ access_token: token, token_type: 'bearer', scope: 'repo,read:org' });
	});

	app.get('/user', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		return c.json(state.user);
	});

	app.get('/user/orgs', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		return c.json(state.orgs);
	});

	app.get('/user/repos', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		return c.json(state.repos.filter((r) => r.owner.login === state.user.login));
	});

	app.get('/orgs/:owner/repos', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const owner = c.req.param('owner');
		return c.json(state.repos.filter((r) => r.owner.login === owner));
	});

	app.get('/repos/:owner/:repo', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const full = `${c.req.param('owner')}/${c.req.param('repo')}`;
		const found = state.repos.find((r) => r.full_name === full);
		if (!found) return c.json({ message: 'Not Found' }, 404);
		return c.json(found);
	});

	app.post('/user/repos', async (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const body = await c.req.json<{ name: string; private?: boolean }>();
		const repo = makeRepo(state.user.login, body.name, body.private ?? true);
		state.repos.push(repo);
		return c.json(repo, 201);
	});

	app.post('/orgs/:owner/repos', async (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const owner = c.req.param('owner');
		const body = await c.req.json<{ name: string; private?: boolean }>();
		const repo = makeRepo(owner, body.name, body.private ?? true);
		state.repos.push(repo);
		return c.json(repo, 201);
	});

	app.post('/user/ssh_signing_keys', async (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const body = await c.req.json<{ title: string; key: string }>();
		const id = nextSigningKeyId++;
		const entry = { id, title: body.title, key: body.key };
		state.signingKeys.push(entry);
		return c.json(entry, 201);
	});

	app.delete('/user/ssh_signing_keys/:id', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const id = Number(c.req.param('id'));
		state.signingKeys = state.signingKeys.filter((k) => k.id !== id);
		return c.body(null, 204);
	});

	function makeRepo(owner: string, name: string, isPrivate: boolean): GitHubSimRepo {
		const id = nextRepoId++;
		return {
			id,
			name,
			full_name: `${owner}/${name}`,
			owner: { login: owner },
			private: isPrivate,
			default_branch: 'main',
			clone_url: `https://github.com/${owner}/${name}.git`,
			ssh_url: `git@github.com:${owner}/${name}.git`,
		};
	}

	const server: Server = createServer(async (req, res) => {
		const url = `http://localhost${req.url}`;
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
		}

		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

		const response = await app.fetch(
			new Request(url, {
				method: req.method,
				headers,
				body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
			}),
		);

		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		const responseBody = await response.arrayBuffer();
		res.end(Buffer.from(responseBody));
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	const baseUrl = `http://localhost:${port}`;

	return {
		baseUrl,
		state,
		seed(partial) {
			if (partial.token) state.token = partial.token;
			if (partial.user) state.user = partial.user;
			if (partial.orgs) state.orgs = partial.orgs;
			if (partial.repos) state.repos = partial.repos;
			if (partial.signingKeys) state.signingKeys = partial.signingKeys;
		},
		approveDeviceFlow(userCode, accessToken) {
			for (const flow of state.deviceFlows.values()) {
				if (flow.userCode === userCode) {
					flow.approvedToken = accessToken ?? state.token;
					return;
				}
			}
			throw new Error(`device flow user_code not found: ${userCode}`);
		},
		addCode(code, accessToken) {
			state.oauthCodes.set(code, accessToken ?? state.token);
		},
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

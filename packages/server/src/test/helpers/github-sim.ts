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
	login: string;
	avatar_url: string;
	email: string | null;
}

export interface GitHubSimState {
	token: string;
	user: GitHubSimUser;
	orgs: GitHubSimOrg[];
	repos: GitHubSimRepo[];
	keys: Array<{ id: number; title: string; key: string }>;
	oauthCodes: Map<string, string>;
}

export interface GitHubSim {
	baseUrl: string;
	state: GitHubSimState;
	seed(partial: Partial<Omit<GitHubSimState, 'oauthCodes'>>): void;
	addCode(code: string, accessToken?: string): void;
	destroy(): Promise<void>;
}

export async function createGitHubSim(): Promise<GitHubSim> {
	const state: GitHubSimState = {
		token: 'gho_sim_test_token',
		user: { login: 'sim-user', avatar_url: '', email: 'sim@hezo.test' },
		orgs: [],
		repos: [],
		keys: [],
		oauthCodes: new Map(),
	};

	let nextRepoId = 10_000;
	let nextKeyId = 100;

	const app = new Hono();

	const isAuthed = (header: string | undefined) =>
		typeof header === 'string' && header === `Bearer ${state.token}`;

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

	app.post('/user/keys', async (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const body = await c.req.json<{ title: string; key: string }>();
		const id = nextKeyId++;
		state.keys.push({ id, title: body.title, key: body.key });
		return c.json({ id, title: body.title, key: body.key }, 201);
	});

	app.delete('/user/keys/:id', (c) => {
		if (!isAuthed(c.req.header('Authorization'))) return c.json({ message: 'Unauthorized' }, 401);
		const id = Number(c.req.param('id'));
		state.keys = state.keys.filter((k) => k.id !== id);
		return c.body(null, 204);
	});

	app.post('/login/oauth/access_token', async (c) => {
		const body = await c.req.json<{ code: string }>();
		const token = state.oauthCodes.get(body.code) ?? state.token;
		return c.json({
			access_token: token,
			token_type: 'bearer',
			scope: 'repo,read:org',
		});
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
			if (partial.keys) state.keys = partial.keys;
		},
		addCode(code, accessToken) {
			state.oauthCodes.set(code, accessToken ?? state.token);
		},
		async destroy() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

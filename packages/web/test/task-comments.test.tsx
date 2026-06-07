import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function setupTaskRoute() {
	const seeded = {
		projectSlug: '',
		taskId: '',
		identifier: '',
		agentSlug: '',
		agentId: '',
	};
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Comment Project' });
			const task = await seedTask(ws, project, { title: 'Comment Test Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.identifier = task.identifier;
			seeded.agentSlug = ws.agents[0].slug;
			seeded.agentId = ws.agents[0].id;
			return { ws, project, task };
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return { ...helpers, seeded };
}

test('task detail shows comments tab with count', async () => {
	const { findByText } = await setupTaskRoute();
	await findByText('Comments', undefined, { timeout: 15_000 });
});

test('can add a comment to a task', async () => {
	const { findByText, findByPlaceholderText, getByRole, user } = await setupTaskRoute();
	const composer = await findByPlaceholderText('Add a comment...');
	await user.type(composer, 'This is a test comment');
	await user.click(getByRole('button', { name: 'Comment' }));
	await findByText('This is a test comment');
});

test('submits comment via Cmd/Ctrl+Enter shortcut', async () => {
	const { findByText, findByPlaceholderText, user } = await setupTaskRoute();
	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	await user.type(composer, 'Submitted via keyboard');
	await user.keyboard('{Meta>}{Enter}{/Meta}');
	await findByText('Submitted via keyboard');
	expect(composer.value).toBe('');
});

test('comments persist after page reload', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Persist Project' });
			const task = await seedTask(ws, project, { title: 'Persist Task' });
			await seedComment(ws, task, 'API-created comment');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	await findByText('API-created comment');
});

test('comment count updates after multiple comments', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Count Project' });
			const task = await seedTask(ws, project, { title: 'Count Task' });
			await seedComment(ws, task, 'First comment');
			await seedComment(ws, task, 'Second comment');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	await findByText('First comment');
	await findByText('Second comment');
});

test('renders markdown in comment bodies and shows author label', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findAllByTestId, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Markdown Project' });
			const task = await seedTask(ws, project, { title: 'Markdown Task' });
			const markdownBody =
				'## Execution Plan\n\nFirst paragraph of the plan.\n\nSecond paragraph after a blank line.\n\n**Objective:** Ship it.\n\n- one\n- two';
			await seedComment(ws, task, markdownBody);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const bodies = await findAllByTestId('text-comment-body');
	const body = bodies[0];
	expect(body.querySelector('h2')?.textContent).toBe('Execution Plan');
	expect(body.querySelector('strong')?.textContent).toBe('Objective:');
	expect(body.querySelectorAll('li').length).toBe(2);
	expect(body.querySelectorAll('p').length).toBe(3);

	const author = container.querySelector('[data-testid="comment-author"]') as HTMLElement;
	expect(author).toBeTruthy();
	expect(author.textContent).toBe('Admin');
});

test('effort dropdown marks the agent default and omits it from the submit body', async () => {
	const seeded = {
		projectSlug: '',
		taskId: '',
		agentSlug: '',
		agentId: '',
		teamId: '',
	};
	const { findByLabelText, findByPlaceholderText, findByText, getByRole, router, ctx } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Effort Project' });
				const task = await seedTask(ws, project, { title: 'Effort Task' });
				seeded.projectSlug = project.slug;
				seeded.taskId = task.identifier.toLowerCase();
				seeded.agentSlug = ws.agents[0].slug;
				seeded.agentId = ws.agents[0].id;
				seeded.teamId = ws.team.id;
			},
		});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const select = (await findByLabelText(
		'Reasoning effort for the agent run triggered by this comment',
	)) as HTMLSelectElement;
	const labels = Array.from(select.options).map((o) => o.textContent ?? '');
	const withSuffix = labels.filter((l) => l.endsWith(' (default)'));
	expect(withSuffix).toHaveLength(1);
	expect(labels).not.toContain('Default');

	// Captain seeds with the 'max' default; other agents may differ. Validate
	// shape rather than exact label so any startup-template default works.
	expect(withSuffix[0]).toMatch(/(Minimal|Low|Medium|High|Max \(ultrathink\)) \(default\)/);

	// Spy on POST /api/.../comments to confirm the body omits `effort`.
	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			const body = init.body;
			if (typeof body === 'string') {
				try {
					posts.push(JSON.parse(body) as Record<string, unknown>);
				} catch {}
			}
		}
		return original(input, init);
	};
	try {
		const composer = await findByPlaceholderText('Add a comment...');
		const { user } = await import('@testing-library/user-event').then((m) => ({
			user: m.default.setup({ delay: null }),
		}));
		await user.type(composer, 'default-effort test');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('default-effort test');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBeGreaterThanOrEqual(1);
	expect(posts[posts.length - 1]).not.toHaveProperty('effort');
});

test('agent mentions render as bold anchor-colored links to agent page', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Project' });
			const task = await seedTask(ws, project, { title: 'Mention Task' });
			const agentSlug = ws.agents[0].slug;
			const body = `Hey @${agentSlug} please check this. Also @not-a-real-agent-xyz stays plain.`;
			await seedComment(ws, task, body);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = agentSlug;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText(/please check this/);

	const mentionLink = container.querySelector(
		'[data-testid="agent-mention-link"]',
	) as HTMLAnchorElement | null;
	expect(mentionLink).toBeTruthy();
	expect(mentionLink!.textContent).toBe(`@${seeded.agentSlug}`);
	expect(mentionLink!.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}`,
	);
	expect(mentionLink!.className).toMatch(/font-semibold/);
	expect(mentionLink!.className).toMatch(/text-accent-blue-text/);

	const allLinks = Array.from(container.querySelectorAll('a')) as HTMLAnchorElement[];
	const fakeMatch = allLinks.find((a) => a.textContent === '@not-a-real-agent-xyz');
	expect(fakeMatch).toBeUndefined();
});

test('wake-assignee checkbox is default-checked and reflected in submit body', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByPlaceholderText, findByText, getByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Wake Project' });
			const task = await seedTask(ws, project, { title: 'Wake Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	const checkbox = await findByRoleClosest(composer, 'checkbox', 'Wake assignee on submit');
	expect(checkbox.checked).toBe(true);

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			const body = init.body;
			if (typeof body === 'string') {
				try {
					posts.push(JSON.parse(body) as Record<string, unknown>);
				} catch {}
			}
		}
		return original(input, init);
	};
	try {
		const userMod = await import('@testing-library/user-event');
		const user = userMod.default.setup({ delay: null });

		await user.type(composer, 'wake-assignee on');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('wake-assignee on');
		expect(composer.value).toBe('');

		expect(checkbox.checked).toBe(true);
		await user.click(checkbox);
		expect(checkbox.checked).toBe(false);

		await user.type(composer, 'wake-assignee off');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('wake-assignee off');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBe(2);
	expect(posts[0].wake_assignee).toBe(true);
	expect(posts[1].wake_assignee).toBe(false);
});

test('replying to an agent hides the wake-assignee toggle and omits the flag', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByPlaceholderText, findByTestId, findByText, getByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Agent Reply Project' });
			const task = await seedTask(ws, project, { title: 'Agent Reply Task' });
			// Author the parent as the assignee agent so author_type is 'agent'.
			await seedComment(ws, task, 'Agent original comment', { authorMemberId: ws.agents[0].id });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Agent original comment');

	const userMod = await import('@testing-library/user-event');
	const user = userMod.default.setup({ delay: null });

	const replyButtons = document.querySelectorAll('[data-testid="comment-reply"]');
	expect(replyButtons.length).toBeGreaterThan(0);
	await user.click(replyButtons[0] as HTMLElement);

	const indicator = await findByTestId('reply-indicator');
	expect(indicator.textContent).toContain('Agent original comment');

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	const form = composer.closest('form');
	expect(form).not.toBeNull();
	// The toggle is gone when the parent is an agent.
	const wakeCheckbox = form?.querySelector(
		'input[type="checkbox"][aria-label="Wake assignee on submit"]',
	);
	expect(wakeCheckbox).toBeNull();

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			const body = init.body;
			if (typeof body === 'string') {
				try {
					posts.push(JSON.parse(body) as Record<string, unknown>);
				} catch {}
			}
		}
		return original(input, init);
	};
	try {
		await user.type(composer, 'My reply to the agent');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('My reply to the agent');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBe(1);
	expect('wake_assignee' in posts[0]).toBe(false);
	// Sanity: it really was sent as a reply to the agent's comment.
	expect(posts[0].parent_comment_id).toBeTruthy();
});

test('replying to a human keeps the wake-assignee toggle and sends the flag', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByPlaceholderText, findByTestId, findByText, getByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Human Reply Project' });
			const task = await seedTask(ws, project, { title: 'Human Reply Task' });
			// seedComment posts via the board token => author_type 'user'.
			await seedComment(ws, task, 'Human original comment');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Human original comment');

	const userMod = await import('@testing-library/user-event');
	const user = userMod.default.setup({ delay: null });

	const replyButtons = document.querySelectorAll('[data-testid="comment-reply"]');
	expect(replyButtons.length).toBeGreaterThan(0);
	await user.click(replyButtons[0] as HTMLElement);

	const indicator = await findByTestId('reply-indicator');
	expect(indicator.textContent).toContain('Human original comment');

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	// The toggle stays for a human-authored parent — nothing else wakes the assignee.
	const checkbox = await findByRoleClosest(composer, 'checkbox', 'Wake assignee on submit');
	expect(checkbox.checked).toBe(true);

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			const body = init.body;
			if (typeof body === 'string') {
				try {
					posts.push(JSON.parse(body) as Record<string, unknown>);
				} catch {}
			}
		}
		return original(input, init);
	};
	try {
		await user.type(composer, 'My reply to the human');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('My reply to the human');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBe(1);
	expect(posts[0].wake_assignee).toBe(true);
	expect(posts[0].parent_comment_id).toBeTruthy();
});

test('reply icon focuses composer, shows in-response-to, and persists parent link', async () => {
	const seeded = { projectSlug: '', taskId: '', parentId: '' };
	const { findByPlaceholderText, findByTestId, queryByTestId, findByText, getByRole, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Reply Project' });
				const task = await seedTask(ws, project, { title: 'Reply Task' });
				const parent = await seedComment(ws, task, 'Original comment to reply to');
				seeded.projectSlug = project.slug;
				seeded.taskId = task.identifier.toLowerCase();
				seeded.parentId = parent.id;
			},
		});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Original comment to reply to');

	const userMod = await import('@testing-library/user-event');
	const user = userMod.default.setup({ delay: null });

	const replyButtons = document.querySelectorAll('[data-testid="comment-reply"]');
	expect(replyButtons.length).toBeGreaterThan(0);
	await user.click(replyButtons[0] as HTMLElement);

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	expect(document.activeElement).toBe(composer);

	const indicator = await findByTestId('reply-indicator');
	expect(indicator.textContent).toContain('In response to');
	expect(indicator.textContent).toContain('Original comment');

	const clear = await findByTestId('clear-reply');
	await user.click(clear);
	expect(queryByTestId('reply-indicator')).toBeNull();

	await user.click(replyButtons[0] as HTMLElement);
	await findByTestId('reply-indicator');

	await user.type(composer, 'Follow-up reply');
	await user.click(getByRole('button', { name: 'Comment' }));

	await findByText('Follow-up reply');
	// The follow-up comment's "replying to" badge appears on the follow-up
	const replyingToBadges = document.querySelectorAll('[data-testid="replying-to"]');
	expect(replyingToBadges.length).toBeGreaterThan(0);
});

// Tiny helper for finding the checkbox by its aria-label within the same form
// as the composer; happy-dom doesn't expose XPath axes the way Playwright does.
async function findByRoleClosest(
	composer: HTMLElement,
	role: string,
	name: string,
): Promise<HTMLInputElement> {
	const form = composer.closest('form');
	if (!form) throw new Error('Composer is not inside a form');
	const input = form.querySelector(`input[type="checkbox"][aria-label="${name}"]`);
	if (!input) throw new Error(`No ${role} named "${name}" inside composer form`);
	return input as HTMLInputElement;
}

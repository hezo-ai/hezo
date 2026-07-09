import { waitFor } from '@testing-library/react';
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

test('expand opens a fullscreen editor with every control, and collapse returns inline', async () => {
	const { findByTestId, findByPlaceholderText, getByRole, queryByTestId, user } =
		await setupTaskRoute();

	// Inline by default: no fullscreen container yet.
	await findByPlaceholderText('Add a comment...');
	expect(queryByTestId('comment-composer-fullscreen')).toBeNull();

	const expandBtn = await findByTestId('comment-expand');
	expect(expandBtn.getAttribute('aria-label')).toBe('Expand comment editor');
	await user.click(expandBtn);

	// Fullscreen editor with the textarea and every auxiliary control still present.
	const fullscreen = await findByTestId('comment-composer-fullscreen');
	expect(fullscreen).toBeTruthy();
	const textarea = await findByPlaceholderText('Add a comment...');
	expect(fullscreen.contains(textarea)).toBe(true);
	expect(fullscreen.querySelector('[data-testid="comment-attachment-upload-button"]')).toBeTruthy();
	expect(fullscreen.querySelector('[data-testid="wake-preview"]')).toBeTruthy();
	expect(getByRole('button', { name: 'Comment' })).toBeTruthy();

	// The toggle flips to collapse and returns the composer inline.
	const collapseBtn = await findByTestId('comment-expand');
	expect(collapseBtn.getAttribute('aria-label')).toBe('Collapse comment editor');
	await user.click(collapseBtn);
	await waitFor(() => expect(queryByTestId('comment-composer-fullscreen')).toBeNull());
	await findByPlaceholderText('Add a comment...');
});

test('draft survives expand and the comment posts from the fullscreen editor', async () => {
	const { findByText, findByTestId, findByPlaceholderText, getByRole, user } =
		await setupTaskRoute();

	// Type inline, then expand — the draft (state lives above the remount) carries over.
	const inline = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	await user.type(inline, 'Drafted inline, sent fullscreen');
	await user.click(await findByTestId('comment-expand'));

	const expanded = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	expect(expanded.value).toBe('Drafted inline, sent fullscreen');

	await user.click(getByRole('button', { name: 'Comment' }));
	await findByText('Drafted inline, sent fullscreen');
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
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
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
	}, original);
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
	expect(mentionLink!.className).toMatch(/text-info-soft-fg/);

	const allLinks = Array.from(container.querySelectorAll('a')) as HTMLAnchorElement[];
	const fakeMatch = allLinks.find((a) => a.textContent === '@not-a-real-agent-xyz');
	expect(fakeMatch).toBeUndefined();
});

test('wake preview shows "(no one)" by default, no checkbox, and submit omits wake_assignee', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByPlaceholderText, findByText, findByTestId, getByRole, router } = await renderApp({
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
	// The legacy checkbox is gone; a "Wake:" preview stands in its place.
	expect(composer.closest('form')?.querySelector('input[type="checkbox"]')).toBeNull();
	const preview = await findByTestId('wake-preview');
	expect(preview.textContent).toContain('Wake:');
	expect(preview.textContent).toContain('(no one)');

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
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
	}, original);
	try {
		const userMod = await import('@testing-library/user-event');
		const user = userMod.default.setup({ delay: null });

		await user.type(composer, 'a plain comment');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('a plain comment');
		expect(composer.value).toBe('');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBe(1);
	expect('wake_assignee' in posts[0]).toBe(false);
});

test('replying to an agent surfaces it as a wake pill and threads the reply', async () => {
	const seeded = { projectSlug: '', taskId: '', agentTitle: '' };
	const { findByPlaceholderText, findByTestId, findAllByTestId, findByText, getByRole, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Agent Reply Project' });
				const task = await seedTask(ws, project, { title: 'Agent Reply Task' });
				// Author the parent as the assignee agent so author_type is 'agent'.
				await seedComment(ws, task, 'Agent original comment', { authorMemberId: ws.agents[0].id });
				seeded.projectSlug = project.slug;
				seeded.taskId = task.identifier.toLowerCase();
				seeded.agentTitle = ws.agents[0].title;
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
	// The button surfaces a visible "Reply" label alongside the icon.
	expect(replyButtons[0].textContent).toContain('Reply');
	await user.click(replyButtons[0] as HTMLElement);

	const indicator = await findByTestId('reply-indicator');
	expect(indicator.textContent).toContain('Agent original comment');

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	expect(composer.closest('form')?.querySelector('input[type="checkbox"]')).toBeNull();
	// Replying to an agent wakes it (reply-wake), so it shows up as a wake pill.
	const pills = await findAllByTestId('wake-pill');
	expect(pills.some((p) => p.textContent === seeded.agentTitle)).toBe(true);

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
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
	}, original);
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

test('actively @-mentioning an agent shows it as a wake pill', async () => {
	const seeded = { projectSlug: '', taskId: '', agentSlug: '', agentTitle: '' };
	const { findByPlaceholderText, findByTestId, findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Wake Project' });
			const task = await seedTask(ws, project, { title: 'Mention Wake Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = ws.agents[0].slug;
			seeded.agentTitle = ws.agents[0].title;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const composer = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	expect((await findByTestId('wake-preview')).textContent).toContain('(no one)');

	const userMod = await import('@testing-library/user-event');
	const user = userMod.default.setup({ delay: null });
	await user.type(composer, `@${seeded.agentSlug} please weigh in`);

	const pills = await findAllByTestId('wake-pill');
	expect(pills.some((p) => p.textContent === seeded.agentTitle)).toBe(true);
	expect((await findByTestId('wake-preview')).textContent).not.toContain('(no one)');
});

test('replying to a human wakes no one (no pill, no wake_assignee)', async () => {
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
	// Replying to a human wakes nobody — no @-mention, no agent reply-target.
	const preview = await findByTestId('wake-preview');
	expect(preview.textContent).toContain('(no one)');
	expect(preview.querySelector('[data-testid="wake-pill"]')).toBeNull();

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
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
	}, original);
	try {
		await user.type(composer, 'My reply to the human');
		await user.click(getByRole('button', { name: 'Comment' }));
		await findByText('My reply to the human');
	} finally {
		globalThis.fetch = original;
	}

	expect(posts.length).toBe(1);
	expect('wake_assignee' in posts[0]).toBe(false);
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

test('copy button copies the comment body and confirms with a check icon', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findAllByTestId, findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Copy Project' });
			const task = await seedTask(ws, project, { title: 'Copy Task' });
			await seedComment(ws, task, 'Copy me please');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	await findByText('Copy me please');

	const writes: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				writes.push(t);
			},
		},
	});
	try {
		const copyBtn = (await findAllByTestId('comment-copy'))[0];
		expect(copyBtn.getAttribute('aria-label')).toBe('Copy comment');
		await user.click(copyBtn);
		expect(writes).toEqual(['Copy me please']);
		// The icon swaps to a check — the aria-label flips to "Copied".
		await waitFor(() => expect(copyBtn.getAttribute('aria-label')).toBe('Copied'));
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('a comment link to another comment renders as a clickable link to its hash', async () => {
	const seeded = { projectSlug: '', taskId: '', targetCommentId: '' };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Comment Link Project' });
			const task = await seedTask(ws, project, { title: 'Comment Link Task' });
			const target = await seedComment(ws, task, 'The original target comment');
			await seedComment(
				ws,
				task,
				`See ${task.identifier}#comment-${target.public_id} for context.`,
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.targetCommentId = target.public_id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	await findByText(/for context/);

	// findByTestId auto-waits for the useTaskMentions resolve to land and re-render.
	const link = (await findByTestId('comment-mention-link')) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/tasks/${seeded.taskId}#comment-${seeded.targetCommentId}`,
	);
});

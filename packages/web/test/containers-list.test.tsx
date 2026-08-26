// The global Containers page: the list, a container's own page, and Remove.
//
// This is the surface that could not exist under the one-container-per-project
// model. Every assertion below is about something that model could not express -
// two projects' containers side by side, a container addressed by its own id,
// and a log that belongs to *that* container rather than to whichever one
// `projects.container_id` happened to name.
//
// Queries are scoped to the table (`within(list)`) rather than the page: a
// project's name is also in the rail and the menu, so an unscoped `findByText`
// passes on chrome that has nothing to do with the list.

import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface Seeded {
	alpha: { id: string; slug: string };
	beta: { id: string; slug: string };
}

interface MemberOpts {
	state?: 'creating' | 'idle' | 'busy' | 'suspended' | 'error';
	hasUnpushedCommits?: boolean;
	lastLogs?: string | null;
	lastError?: string | null;
	/** The cap this container was provisioned to cover. Null for one never recorded. */
	memoryBytes?: number | null;
}

/** Two teams, each with its project - the 1:1 model means two teams for two projects. */
async function seedTwoProjects(): Promise<Seeded> {
	const { db } = getTestContext();
	const made: Record<string, { id: string; slug: string }> = {};
	for (const name of ['Alpha', 'Beta']) {
		const team = await createTestTeam(db, { name: `Containers ${name}` });
		const teamId = (await team.json()).data.id;
		const project = await createTestProject(db, teamId, { name });
		const row = (await project.json()).data;
		made[name] = { id: row.id, slug: row.slug };
	}
	return { alpha: made.Alpha, beta: made.Beta };
}

async function addMember(projectId: string, containerId: string, o: MemberOpts = {}) {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO container_pool_members
		   (project_id, container_id, state, disk_ceiling_bytes, disk_used_bytes,
		    has_unpushed_commits, last_logs, last_error, memory_bytes)
		 VALUES ($1, $2, $3::container_pool_state, $4, $5, $6, $7, $8, $9)`,
		[
			projectId,
			containerId,
			o.state ?? 'idle',
			20 * 1024 ** 3,
			5 * 1024 ** 3,
			o.hasUnpushedCommits ?? false,
			o.lastLogs ?? null,
			o.lastError ?? null,
			o.memoryBytes === undefined ? String(2 * 1024 ** 3) : o.memoryBytes,
		],
	);
}

/**
 * Drop the container the harness pins to HQ.
 *
 * It is a real row in the other representation (`projects.container_id`), which
 * is exactly what the listing is meant to pick up - so it is cleared only where
 * a test is asserting on what an operator sees with nothing running.
 */
async function clearSeededContainers() {
	const { db } = getTestContext();
	// Both representations: the harness seeds a pool member for HQ as well as
	// the project-row pointer, and the listing reads the union of the two.
	await db.query('DELETE FROM container_pool_members');
	await db.query('UPDATE projects SET container_id = NULL, container_status = NULL');
}

test('the list shows every project’s containers, with the badge that explains a held one', async () => {
	let seeded!: Seeded;
	const { findByTestId } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-one', { state: 'busy' });
			await addMember(seeded.alpha.id, 'alpha-two');
			await addMember(seeded.beta.id, 'beta-one', { hasUnpushedCommits: true });
		},
	});

	const list = within(await findByTestId('containers-list', undefined, { timeout: 20_000 }));

	// Both projects, in one list, and Alpha with two containers of its own -
	// neither of which the old per-project page could have distinguished.
	expect((await list.findAllByText('Alpha', undefined, { timeout: 20_000 })).length).toBe(2);
	await list.findByText('Beta');

	// The state is the answer to "is anything stuck", so it is rendered per row
	// rather than inferred from a project-level status.
	expect((await findByTestId('container-state-alpha-one')).textContent).toBe('Running a task');
	expect((await findByTestId('container-state-beta-one')).textContent).toBe('Idle');

	// The badge says why a container is not being recycled - the reason an
	// operator would otherwise read as a leak.
	await findByTestId('container-unpushed-beta-one');
});

test('the list marks a container that reported an error, whatever its state says', async () => {
	// The list and the detail page used to disagree: only a provision that threw
	// sets `state = 'error'`, while an OOM kill or a container that vanished
	// records `last_error` and keeps the state it had - so a container whose
	// detail page was red read as a plain `Idle` row, and an operator scanning the
	// list had no way to find the one that had failed.
	let seeded!: Seeded;
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-one', { lastError: 'exited with code 137' });
			await addMember(seeded.beta.id, 'beta-one');
		},
	});

	await findByTestId('containers-list', undefined, { timeout: 20_000 });
	// Still `Idle` - the mark is what carries the error, not the badge.
	expect((await findByTestId('container-state-alpha-one')).textContent).toBe('Idle');
	await findByTestId('container-error-mark-alpha-one');
	// And a healthy container is not marked, so the mark means something.
	expect(queryByTestId('container-error-mark-beta-one')).toBeNull();
});

test('an instance with nothing running says so rather than showing an empty table', async () => {
	const { findByText } = await renderApp({
		initialPath: '/settings/containers',
		seed: clearSeededContainers,
	});
	await findByText('No containers running', undefined, { timeout: 20_000 });
});

test('clicking a row opens that container’s own page, with its captured log', async () => {
	let seeded!: Seeded;
	const { findByText, findByTestId, user } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-one');
			await addMember(seeded.beta.id, 'beta-crashed', {
				state: 'error',
				lastError: 'exited with code 137',
				lastLogs: 'building image\nkilled: out of memory',
			});
		},
	});

	const list = within(await findByTestId('containers-list', undefined, { timeout: 20_000 }));
	await user.click(await list.findByText('Beta', undefined, { timeout: 20_000 }));

	const detail = await findByTestId('container-detail', undefined, { timeout: 20_000 });
	expect(detail.textContent).toContain('beta-crashed');
	expect((await findByTestId('container-detail-state')).textContent).toBe('Failed');
	expect((await findByTestId('container-detail-error')).textContent).toContain(
		'exited with code 137',
	);

	// The log survives the container: `last_logs` is captured on the member row,
	// so the page that explains a death still has the output that caused it.
	await findByText('killed: out of memory');
});

test('a container’s page links out to its project and to the task it last ran', async () => {
	// Both used to be dead ends: the project name pointed at the per-project
	// container page this rearchitecture reduced to settings, and the task was
	// plain text - so the two questions the page raises ("whose is this", "what
	// was it doing") could not be followed up from it.
	let seeded!: Seeded;
	let taskIdentifier!: string;
	const { findByTestId, user } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			const { db } = getTestContext();
			await clearSeededContainers();
			seeded = await seedTwoProjects();
			// Numbered past whatever provisioning the project already created (its
			// planning task is #1), so this is about the link, not the sequence.
			const task = await db.query<{ id: string; identifier: string }>(
				`WITH n AS (SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tasks WHERE project_id = $1)
				 INSERT INTO tasks (project_id, team_id, number, title, identifier, status)
				 SELECT $1, p.team_id, n.next, 'Ran here', p.task_prefix || '-' || n.next,
				        'in_progress'::task_status
				   FROM projects p, n WHERE p.id = $1
				 RETURNING id, identifier`,
				[seeded.alpha.id],
			);
			taskIdentifier = task.rows[0].identifier;
			await addMember(seeded.alpha.id, 'alpha-linked');
			await db.query(
				'UPDATE container_pool_members SET last_task_id = $1 WHERE container_id = $2',
				[task.rows[0].id, 'alpha-linked'],
			);
		},
	});

	const list = within(await findByTestId('containers-list', undefined, { timeout: 20_000 }));
	await user.click(await list.findByText('Alpha', undefined, { timeout: 20_000 }));

	const detail = await findByTestId('container-detail', undefined, { timeout: 20_000 });
	const projectLink = within(detail).getByRole('link', { name: 'Alpha' });
	expect(projectLink.getAttribute('href')).toBe(`/projects/${seeded.alpha.slug}`);

	const taskLink = await findByTestId('container-detail-task');
	expect(taskLink.getAttribute('href')).toBe(
		`/projects/${seeded.alpha.slug}/tasks/${taskIdentifier.toLowerCase()}`,
	);
});

test('a provision with no engine id yet is listed, and offers no Remove', async () => {
	// The window an operator is sent into by "View container" on the HQ notice:
	// the container has no id until the engine returns one, so the page it links
	// to had nothing at all to show.
	let seeded!: Seeded;
	const { findByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			const { db } = getTestContext();
			await clearSeededContainers();
			seeded = await seedTwoProjects();
			await db.query(
				`UPDATE projects SET container_id = NULL,
				        container_status = 'creating'::container_status WHERE id = $1`,
				[seeded.alpha.id],
			);
		},
	});

	const list = within(await findByTestId('containers-list', undefined, { timeout: 20_000 }));
	await user.click(await list.findByText('Alpha', undefined, { timeout: 20_000 }));

	const detail = await findByTestId('container-detail', undefined, { timeout: 20_000 });
	expect(within(detail).getByTestId('container-detail-state').textContent).toBe('Starting');
	// Nothing exists on the engine to remove, so the affordance is not offered.
	expect(queryByTestId('container-remove')).toBeNull();
});

test('Remove confirms, deletes the container, and drops it from the list', async () => {
	let seeded!: Seeded;
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			await clearSeededContainers();
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-doomed', { state: 'suspended' });
		},
	});

	await router.navigate({
		to: '/settings/containers/$containerId',
		params: { containerId: 'alpha-doomed' },
	});

	await user.click(await findByTestId('container-remove', undefined, { timeout: 20_000 }));
	// The confirm names what is lost, since nothing else on the page does.
	await findByText('Remove this container?');
	expect(document.body.textContent).toContain('has not reached a git remote is lost');

	await user.click(await findByTestId('confirm-dialog-confirm'));

	// The member row is gone, which is what the next run's pool lookup reads.
	const { db } = getTestContext();
	await waitFor(
		async () => {
			const rows = await db.query('SELECT 1 FROM container_pool_members WHERE container_id = $1', [
				'alpha-doomed',
			]);
			expect(rows.rows.length).toBe(0);
		},
		{ timeout: 15_000 },
	);

	// And the operator is back on a list that no longer offers it.
	const list = within(await findByTestId('containers-list', undefined, { timeout: 20_000 }));
	await waitFor(() => expect(list.queryByText('Alpha')).toBeNull(), { timeout: 15_000 });
});

test('a container that is still coming up says its log is awaited, not absent', async () => {
	// The empty log of a container mid-provision and of one that came up silently
	// are the same zero lines, and the terminal wording described the second - so
	// a container whose provisioning trace was still being written read as one
	// that had finished and said nothing.
	let seeded!: Seeded;
	const { findByTestId, router } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			await clearSeededContainers();
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-starting', { state: 'creating', lastLogs: null });
			await addMember(seeded.beta.id, 'beta-stopped', { state: 'suspended', lastLogs: null });
		},
	});

	await router.navigate({
		to: '/settings/containers/$containerId',
		params: { containerId: 'alpha-starting' },
	});
	const starting = await findByTestId('container-detail-logs', undefined, { timeout: 20_000 });
	expect(starting.textContent).toContain('Waiting for logs');

	// And the terminal wording survives where it is still true, so the condition
	// says something rather than replacing the message everywhere.
	await router.navigate({
		to: '/settings/containers/$containerId',
		params: { containerId: 'beta-stopped' },
	});
	await waitFor(
		async () => {
			const stopped = await findByTestId('container-detail-logs');
			expect(stopped.textContent).toContain('No output was captured');
		},
		{ timeout: 20_000 },
	);
});

test('removing a container that is serving a run says so before it ends the run', async () => {
	// The main reason to reach for Remove, and the one case where the generic
	// copy would understate it: the run dies the same way it would if the
	// container had crashed, so the dialog has to say that up front.
	let seeded!: Seeded;
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/settings/containers',
		seed: async () => {
			seeded = await seedTwoProjects();
			await addMember(seeded.alpha.id, 'alpha-busy', { state: 'busy' });
			const { db } = getTestContext();
			const member = await db.query<{ id: string; team_id: string }>(
				'SELECT id, team_id FROM members ORDER BY created_at LIMIT 1',
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, status, container_id, started_at)
				 VALUES ($1, $2, 'running', $3, now())`,
				[member.rows[0].team_id, member.rows[0].id, 'alpha-busy'],
			);
		},
	});

	await router.navigate({
		to: '/settings/containers/$containerId',
		params: { containerId: 'alpha-busy' },
	});

	await user.click(await findByTestId('container-remove', undefined, { timeout: 20_000 }));
	await findByText('Remove this container?');
	expect(document.body.textContent).toContain('A task is running on this container right now');
});

import { INSTANCE_AGENT_SLUGS } from '@hezo/shared';
import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// The team page is where "who is this?" gets answered, so the org chart node has
// to carry both halves of an agent's identity - but only when they differ. A
// named agent shows the name over its role; an unnamed one shows the role once,
// because for it the label *is* the role and a second line would repeat it.
//
// Scoped to the chart rather than the document: the project sidebar lists the
// same agents, so a page-wide query for a role is ambiguous once both render.

async function nameAgent(projectSlug: string, agentSlug: string, humanName: string) {
	const { token, apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ human_name: humanName }),
	});
	if (!res.ok) throw new Error(`naming ${agentSlug} failed: ${res.status}`);
}

test('a named agent shows its name over its role; an unnamed one shows the role once', async () => {
	let nav!: { projectSlug: string; namedSlug: string; namedTitle: string; plainTitle: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const named = ws.agents.find((a) => a.slug === 'engineer');
			const plain = ws.agents.find((a) => a.slug === 'architect');
			if (!named || !plain) throw new Error('seed: expected roster roles missing');
			// Nothing on a built-in team ships a name, so the named case has to be
			// made the way a human makes it - from the agent's settings.
			await nameAgent(ws.internalSlug, named.slug, 'Riley');
			nav = {
				projectSlug: ws.internalSlug,
				namedSlug: named.slug,
				namedTitle: named.title,
				plainTitle: plain.title,
			};
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: nav.projectSlug },
	});

	const chart = await findByTestId('team-org-chart');
	const namedNode = await within(chart).findByTestId(`org-node-${nav.namedSlug}`);

	// Both halves, in that order: the name is what you call them, the role is what
	// they do. Before this change the node showed only the name.
	expect(within(namedNode).getByText('Riley')).toBeTruthy();
	expect(within(namedNode).getByText(nav.namedTitle)).toBeTruthy();

	// The unnamed teammate keeps one line - its role, said once.
	const plainNodes = within(chart).getAllByText(nav.plainTitle);
	expect(plainNodes).toHaveLength(1);
});

test('every roster agent is addressed by its role out of the box', async () => {
	// The built-in teams used to ship a first name per role, so a fresh project
	// read "Max" and "Ada" with no way to see who did what. Nobody arrives named.
	let nav!: { projectSlug: string; titles: string[] };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			// Nobody arrives named - that is the guarantee. The chart itself only
			// draws the team's own roster, so the HQ singletons (CEO / Coach, listed
			// separately on the page) are excluded from the DOM half below.
			expect(ws.agents.every((a) => !a.human_name)).toBe(true);
			nav = {
				projectSlug: ws.internalSlug,
				titles: ws.agents
					.filter((a) => !(INSTANCE_AGENT_SLUGS as readonly string[]).includes(a.slug))
					.map((a) => a.title),
			};
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: nav.projectSlug },
	});

	const chart = await findByTestId('team-org-chart');
	await within(chart).findByText(nav.titles[0]);
	for (const title of nav.titles) {
		// One line per node: the role, with no name above it to explain.
		expect(within(chart).getAllByText(title)).toHaveLength(1);
	}
});

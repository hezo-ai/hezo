import { expect, test } from 'vitest';
import { clickUntil, getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

const ROW = (i: number) => `SEEDROW${String(i).padStart(3, '0')}`;
const shown = (name: string) => document.body.textContent?.includes(name) ?? false;

// The activity feed pages by cursor, not by page number: the table only grows and
// is never pruned, so a total would cost a full-table count per page load. This
// asserts the walk is complete - the second page must yield the older rows the
// first page cut off, with no row repeated across the boundary.
test('instance Activity log loads older entries beyond the first page', async () => {
	const { findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
			const { db } = getTestContext();
			// One more than the 50-row page size, so exactly one row falls onto page 2.
			// created_at descends with i, so SEEDROW000 is newest and SEEDROW050 oldest.
			for (let i = 0; i <= 50; i++) {
				await db.query(
					`INSERT INTO audit_log (project_id, actor_type, action, entity_type, entity_id, details, created_at)
					 VALUES (NULL, 'admin'::audit_actor_type, 'created', 'secret', NULL, $1::jsonb, now() - ($2 || ' seconds')::interval)`,
					[JSON.stringify({ name: ROW(i) }), String(i)],
				);
			}
		},
	});

	await router.navigate({ to: '/settings/audit-log' });

	// Page 1 holds the 50 newest rows and stops short of the oldest.
	await findByText(new RegExp(ROW(0)), undefined, { timeout: 20_000 });
	expect(shown(ROW(50))).toBe(false);

	await clickUntil(
		user,
		() => document.querySelector('[data-testid="load-older-activity"]'),
		() => shown(ROW(50)),
		{ label: 'load older activity', timeout: 20_000 },
	);

	// Page 1 stays rendered beneath page 2 - this appends, it does not replace.
	expect(shown(ROW(0))).toBe(true);
	// The feed is exhausted, so the control retires rather than paging forever.
	expect(document.querySelector('[data-testid="load-older-activity"]')).toBeNull();
	// No row is repeated across the page boundary.
	expect(document.body.textContent?.match(new RegExp(ROW(49), 'g'))?.length).toBe(1);
}, 40_000);

import { CAPTAIN_AGENT_SLUG, type MarketplaceTeamDef } from '@hezo/shared';
import type { Agent } from '../hooks/use-agents';
import type { TeamTemplateAgentType } from '../hooks/use-team-templates';

/**
 * One role as the roster views render it, normalised from whichever source it came
 * from — a marketplace team def, a local team template's agent types, or a project's
 * live hired agents. `reportsTo` is already a display string (see `resolveReportsTo`),
 * so this component stays purely presentational.
 */
export interface TeamRosterRow {
	slug: string;
	title: string;
	reportsTo: string;
	roleDescription: string;
}

/**
 * Every provisioned-from-a-template roster gets a Captain that the template itself
 * never lists (marketplace defs and team templates both describe only the worker
 * roles). Callers on those paths prepend this row; a roster read from a project's
 * live agents does not, because its Captain is already a real agent.
 */
export const CAPTAIN_ROSTER_ROW: TeamRosterRow = {
	slug: CAPTAIN_AGENT_SLUG,
	title: 'Captain',
	reportsTo: 'CEO',
	roleDescription: 'Leads the team and delegates work.',
};

/**
 * Prepend the synthetic Captain unless the source already carries one. A marketplace
 * roster never does (`RESERVED_ROSTER_SLUGS` forbids it), but a local team template's
 * `agent_types` may well include the builtin Captain agent type — prepending blindly
 * there renders it twice (and duplicates a React key).
 */
function withCaptain(roles: TeamRosterRow[]): TeamRosterRow[] {
	return roles.some((r) => r.slug === CAPTAIN_AGENT_SLUG) ? roles : [CAPTAIN_ROSTER_ROW, ...roles];
}

/** The dash shown when a role reports to nobody in the roster. */
const NO_REPORTS_TO = '—';

/**
 * Turn a `reports_to_slug` into something a human reads: the title of the role it
 * points at, falling back to the raw slug when it names a role outside `rows` (and
 * to a dash when it is null).
 */
export function resolveReportsTo(
	slug: string | null | undefined,
	rows: { slug: string; title: string }[],
): string {
	if (!slug) return NO_REPORTS_TO;
	return rows.find((r) => r.slug === slug)?.title ?? slug;
}

/**
 * A marketplace team's roles. The def's `roster` deliberately excludes the Captain —
 * it is provisioned alongside every template — so it is prepended here.
 */
export function marketplaceRosterRows(def: MarketplaceTeamDef): TeamRosterRow[] {
	const roles = [...def.roster].sort((a, b) => a.sort_order - b.sort_order);
	const known = [CAPTAIN_ROSTER_ROW, ...roles];
	return withCaptain(
		roles.map((r) => ({
			slug: r.slug,
			title: r.title,
			reportsTo: resolveReportsTo(r.reports_to_slug, known),
			roleDescription: r.role_description,
		})),
	);
}

/** A local team template's roles. Same Captain rule as a marketplace team. */
export function templateRosterRows(agentTypes: TeamTemplateAgentType[]): TeamRosterRow[] {
	const roles = [...agentTypes].sort((a, b) => a.sort_order - b.sort_order);
	const known = [CAPTAIN_ROSTER_ROW, ...roles.map((a) => ({ slug: a.slug, title: a.name }))];
	return withCaptain(
		roles.map((a) => ({
			slug: a.slug,
			title: a.name,
			reportsTo: resolveReportsTo(a.reports_to_slug, known),
			roleDescription: a.role_description,
		})),
	);
}

/**
 * A live team's hired agents. No synthetic Captain — the real one is already a member.
 * HQ's CEO/Coach are surfaced on every project as virtual members (`is_instance`), so
 * they are filtered out: they are not part of the roster a clone would copy.
 */
export function agentRosterRows(agents: Agent[]): TeamRosterRow[] {
	return (
		agents
			.filter((a) => !a.is_instance)
			.map((a) => ({
				slug: a.slug,
				title: a.title,
				reportsTo: a.reports_to_title ?? NO_REPORTS_TO,
				roleDescription: a.role_description ?? '',
			}))
			// The API orders agents by title; lead with the Captain instead so a live
			// team's roster reads top-down like the marketplace and template ones do.
			.sort((a, b) => (a.slug === CAPTAIN_AGENT_SLUG ? -1 : b.slug === CAPTAIN_AGENT_SLUG ? 1 : 0))
	);
}

// Written out literally (not composed at runtime) so Tailwind's source scan sees
// every class it has to generate.
const ROW_GRID = 'grid grid-cols-1 sm:grid-cols-[9rem_8rem_1fr] gap-x-4';
const HEADER_GRID = 'hidden sm:grid grid-cols-[9rem_8rem_1fr] gap-x-4';

/**
 * A team's roster: role, who it reports to, and what it's responsible for. Shared by
 * the marketplace team page and the New Project dialog's team detail step.
 *
 * One DOM that reflows rather than a `<table>` in an `overflow-x-auto`: at <640px the
 * three fields stack per role (a 3-column table is a horizontal-scroll experience on a
 * phone), and from `sm:` up the same markup lays out as aligned columns under a header
 * row. Rendering two variants behind `sm:hidden`/`hidden sm:block` instead would put
 * every role's text in the DOM twice, which breaks `getByText`/`getByTestId`.
 */
export function TeamRosterTable({ rows, testId }: { rows: TeamRosterRow[]; testId?: string }) {
	return (
		<ul className="divide-y divide-border/60" data-testid={testId}>
			<li className={`${HEADER_GRID} border-b border-border py-2 text-[12px] text-text-2`}>
				<span>Role</span>
				<span>Reports to</span>
				<span>Responsibility</span>
			</li>
			{rows.map((r) => (
				<li
					key={r.slug}
					data-testid={`roster-row-${r.slug}`}
					className={`${ROW_GRID} gap-y-0.5 py-2 text-[13px]`}
				>
					<span className="font-medium">{r.title}</span>
					<span className="text-[12px] text-text-2 sm:text-[13px]">
						<span className="sm:hidden">Reports to </span>
						{r.reportsTo}
					</span>
					<span className="text-[12px] text-text-2 sm:text-[13px]">{r.roleDescription}</span>
				</li>
			))}
		</ul>
	);
}

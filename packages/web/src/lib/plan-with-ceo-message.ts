import type { MessageKey } from './i18n';
import type { TeamOption } from './team-suggestions';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** What the New Project form holds when the admin picks "Plan with the CEO". */
export interface PlanWithCeoForm {
	name: string;
	description: string;
	/** The team the admin picked, or null when they want the CEO to propose one. */
	team: TeamOption | null;
	/** A project plan travels as an attachment; the message only says it is there. */
	hasPlan: boolean;
	/** The project a copied team comes from, by name. Only read for a copied team. */
	copiedFromProject?: string;
}

/**
 * The admin's first message to the CEO, composed from the New Project form. It
 * is sent as the admin's own words, so every line is one catalog sentence and
 * the description stands as its own paragraph. A ready-made team names its slug
 * so the CEO can pass it to `create_project` unchanged.
 */
export function composePlanWithCeoMessage(t: Translate, form: PlanWithCeoForm): string {
	const header = [t('chat.planProject.intro'), t('chat.planProject.name', { name: form.name })];
	const team = form.team;
	if (!team) {
		header.push(t('chat.planProject.team.none'));
	} else if (team.kind === 'marketplace') {
		header.push(t('chat.planProject.team.marketplace', { team: team.name, slug: team.slug }));
	} else if (team.kind === 'template') {
		header.push(t('chat.planProject.team.template', { team: team.name }));
	} else {
		header.push(
			t('chat.planProject.team.copy', {
				team: team.name,
				project: form.copiedFromProject ?? team.projectSlug,
			}),
		);
	}
	if (form.hasPlan) header.push(t('chat.planProject.plan'));
	return `${header.join('\n')}\n\n${form.description}`;
}

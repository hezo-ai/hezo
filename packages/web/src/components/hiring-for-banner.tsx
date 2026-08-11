import { Link } from '@tanstack/react-router';
import { UserPlus } from 'lucide-react';
import { useProjectMeta } from '../hooks/use-projects';
import { type MessageKey, Trans, useI18n } from '../lib/i18n';

/**
 * Says which project the operator is mid-hire for, on the marketplace pages they
 * were sent to by the hire chooser. Without it the catalog looks like the ordinary
 * top-nav marketplace, and "Add to a project" reads as a fresh decision rather
 * than the continuation of one already made.
 */
export function HiringForBanner({
	projectId,
	messageKey,
}: {
	projectId: string;
	messageKey: MessageKey;
}) {
	const { t } = useI18n();
	const project = useProjectMeta(projectId);
	const projectName = project?.name ?? projectId;

	return (
		<div
			data-testid="hiring-for-banner"
			className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-accent-soft-fg bg-accent-soft px-3 py-2.5 text-[12.5px] text-accent-soft-fg"
		>
			<UserPlus className="h-[15px] w-[15px] shrink-0" aria-hidden />
			<span className="min-w-0 flex-1">
				<Trans k={messageKey} vars={{ project: <b className="font-semibold">{projectName}</b> }} />
			</span>
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				className="shrink-0 underline underline-offset-2 opacity-85 hover:opacity-100"
			>
				{t('common.cancel')}
			</Link>
		</div>
	);
}

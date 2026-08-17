import type { Team } from '../../hooks/use-teams';
import { SectionHeader } from './helpers';

export function GeneralSection({ team }: { team: Team | undefined }) {
	return (
		<section>
			<SectionHeader title="General" desc="Basic team information." />
			<div className="space-y-3 max-w-md">
				<div>
					<span className="text-xs font-medium uppercase tracking-wider text-text-2 block mb-1.5">
						Team name
					</span>
					<div className="text-[13px]">{team?.name ?? '-'}</div>
				</div>
				{team?.description && (
					<div>
						<span className="text-xs font-medium uppercase tracking-wider text-text-2 block mb-1.5">
							Description
						</span>
						<div className="text-[13px] text-text-2">{team.description}</div>
					</div>
				)}
			</div>
		</section>
	);
}

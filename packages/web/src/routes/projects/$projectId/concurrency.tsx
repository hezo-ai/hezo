import {
	HQ_PROJECT_SLUG,
	MAX_RUNS_PER_PROJECT_MAX,
	MAX_RUNS_PER_PROJECT_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	RAM_CAP_PER_CONTAINER_GB_STEP,
	roundRamCapGb,
} from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useInstanceSettings } from '../../../hooks/use-instance-settings';
import { useProject, useUpdateProject } from '../../../hooks/use-projects';
import { useI18n } from '../../../lib/i18n';

/**
 * This project's overrides for the two per-project concurrency knobs. Both are
 * "empty means inherit": the global value from Settings > Concurrency shows as
 * the input's placeholder so the effective number is always visible, and
 * clearing the field writes null rather than a copy of the default (which would
 * silently stop tracking later changes to it).
 */
function ProjectConcurrencyPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { data: project } = useProject(projectId);
	const { data: settings } = useInstanceSettings();

	if (!project) return null;

	return (
		<div className="max-w-[900px] space-y-6">
			<div>
				{/* Reuses the global page's term so a language calls this one thing. */}
				<h1 className="text-[22px] font-medium">{t('settings.concurrency')}</h1>
				<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
					{t('projectConcurrency.intro')}
				</p>
			</div>

			<section className="border border-border rounded-md p-4 bg-surface">
				<label className="block text-[13px] font-medium mb-1" htmlFor="project-max-runs-input">
					{t('projectConcurrency.maxRuns.label')}
				</label>
				<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
					{t('projectConcurrency.maxRuns.help')}
				</p>
				<OverrideForm
					projectId={projectId}
					inputId="project-max-runs-input"
					testIdPrefix="project-max-runs"
					current={project.max_concurrent_runs}
					inherited={settings?.default_max_runs_per_project}
					min={MAX_RUNS_PER_PROJECT_MIN}
					max={MAX_RUNS_PER_PROJECT_MAX}
					toPatch={(v) => ({ max_concurrent_runs: v })}
				/>
			</section>

			<section className="border border-border rounded-md p-4 bg-surface">
				<label className="block text-[13px] font-medium mb-1" htmlFor="memory-limit-gib-input">
					{t('projectConcurrency.memory.label')}
				</label>
				<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
					{t('projectConcurrency.memory.help')}
				</p>
				<OverrideForm
					projectId={projectId}
					inputId="memory-limit-gib-input"
					testIdPrefix="memory-limit-gib"
					current={project.memory_limit_gib}
					inherited={settings?.default_ram_cap_per_container_gb}
					min={RAM_CAP_PER_CONTAINER_GB_MIN}
					max={RAM_CAP_PER_CONTAINER_GB_MAX}
					step={RAM_CAP_PER_CONTAINER_GB_STEP}
					decimal
					toPatch={(v) => ({ memory_limit_gib: v === null ? null : roundRamCapGb(v) })}
				/>
			</section>
		</div>
	);
}

/**
 * Both sections are the same control - a number input whose empty state means
 * "inherit" - so they share one component rather than two near-copies that
 * would drift. `decimal` switches parsing, the step, and which range-error
 * message is shown.
 */
function OverrideForm({
	projectId,
	inputId,
	testIdPrefix,
	current,
	inherited,
	min,
	max,
	step,
	decimal = false,
	toPatch,
}: {
	projectId: string;
	inputId: string;
	testIdPrefix: string;
	current: number | null;
	inherited: number | undefined;
	min: number;
	max: number;
	step?: number;
	decimal?: boolean;
	toPatch: (value: number | null) => {
		max_concurrent_runs?: number | null;
		memory_limit_gib?: number | null;
	};
}) {
	const { t } = useI18n();
	const updateProject = useUpdateProject(projectId);
	const [value, setValue] = useState(current === null ? '' : String(current));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const trimmed = value.trim();
		if (trimmed !== '') {
			const n = decimal ? Number.parseFloat(trimmed) : Number.parseInt(trimmed, 10);
			if (Number.isNaN(n) || n < min || n > max) {
				setError(
					t(decimal ? 'concurrency.decimalRangeError' : 'concurrency.rangeError', { min, max }),
				);
				return;
			}
			await updateProject.mutateAsync(toPatch(n));
			return;
		}
		// Empty clears the override so the project tracks the global default again.
		await updateProject.mutateAsync(toPatch(null));
	}

	const dirty = value.trim() !== (current === null ? '' : String(current));

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id={inputId}
					data-testid={`${testIdPrefix}-input`}
					type="number"
					inputMode={decimal ? 'decimal' : 'numeric'}
					step={step}
					min={min}
					max={max}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={
						inherited === undefined
							? undefined
							: t('projectConcurrency.inheritPlaceholder', { value: inherited })
					}
					className="sm:w-48"
				/>
				<Button
					size="sm"
					data-testid={`${testIdPrefix}-save`}
					onClick={handleSave}
					disabled={!dirty || updateProject.isPending}
				>
					{updateProject.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
			</div>
			<p className="text-[13px] text-text-2 mt-1.5" data-testid={`${testIdPrefix}-value`}>
				{current === null
					? t('projectConcurrency.inheriting', { value: inherited ?? '' })
					: t('projectConcurrency.overridden', { value: current })}
			</p>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid={`${testIdPrefix}-error`}>
					{error}
				</p>
			)}
		</>
	);
}

export const Route = createFileRoute('/projects/$projectId/concurrency')({
	beforeLoad: ({ params }) => {
		// HQ has no Settings node in the sidebar, so it has no Concurrency page
		// either. It still gets both limits server-side, inheriting the globals.
		if (params.projectId === HQ_PROJECT_SLUG) {
			throw redirect({ to: '/projects/$projectId/tasks', params, replace: true });
		}
	},
	component: ProjectConcurrencyPage,
});

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useInstanceSettings } from '../hooks/use-instance-settings';
import { useProject, useUpdateProject } from '../hooks/use-projects';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * How much memory this project's containers may each take.
 *
 * On the project's **Container** page rather than in its General settings,
 * where it used to sit between the project name and its description. It is a
 * property of the containers, it only means anything alongside their state, and
 * an operator who has come to look at a container is the one who wants to change
 * it - filed under General it read as project metadata.
 *
 * Empty means no override: the container inherits the instance default, which is
 * shown so the field is never a blank that hides a real number.
 */
export function ProjectMemoryLimitSection({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const { data: project } = useProject(projectId);
	const { data: settings } = useInstanceSettings();
	const updateProject = useUpdateProject(projectId);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);

	if (!project) return null;
	const inherited = settings?.default_ram_cap_per_container_gb;

	async function save() {
		const trimmed = value.trim();
		setError(null);
		if (trimmed !== '') {
			const parsed = Number(trimmed);
			if (!Number.isInteger(parsed) || parsed < 1) {
				setError(t('container.memoryLimit.invalid'));
				return;
			}
		}
		try {
			await updateProject.mutateAsync({
				memory_limit_gib: trimmed === '' ? null : Number(trimmed),
			});
			setEditing(false);
		} catch (e) {
			// The server refuses a cap larger than the whole instance budget, because
			// such a container could never be scheduled. That message names the
			// budget, so it belongs on screen rather than being replaced.
			setError((e as Error).message);
		}
	}

	return (
		<section
			className="border border-border rounded-md p-4 bg-surface"
			data-testid="project-memory-limit"
		>
			<h2 className="text-[13px] font-medium mb-1">{t('container.memoryLimit.label')}</h2>
			<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
				{t('container.memoryLimit.help')}
			</p>
			{editing ? (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						data-testid="project-memory-limit-input"
						type="number"
						inputMode="numeric"
						min={1}
						placeholder={inherited ? String(inherited) : ''}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className="sm:w-40"
					/>
					<Button
						size="sm"
						data-testid="project-memory-limit-save"
						onClick={save}
						disabled={updateProject.isPending}
					>
						{updateProject.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
						{t('common.save')}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
						{t('common.cancel')}
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-3">
					<span className="text-[13px]" data-testid="memory-limit-gib-value">
						{project.memory_limit_gib === null
							? t('container.memoryLimit.inherited', { value: inherited ?? '-' })
							: t('container.memoryLimit.override', { value: project.memory_limit_gib })}
					</span>
					<Button
						size="sm"
						variant="outline"
						data-testid="project-memory-limit-edit"
						onClick={() => {
							setValue(project.memory_limit_gib === null ? '' : String(project.memory_limit_gib));
							setError(null);
							setEditing(true);
						}}
					>
						{t('common.edit')}
					</Button>
				</div>
			)}
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="project-memory-limit-error">
					{error}
				</p>
			)}
		</section>
	);
}

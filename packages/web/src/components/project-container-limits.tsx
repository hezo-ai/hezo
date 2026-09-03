import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useInstanceSettings } from '../hooks/use-instance-settings';
import { useProject, useUpdateProject } from '../hooks/use-projects';
import { type MessageKey, useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * A project's override of one instance-wide container limit.
 *
 * Two of these exist - memory and disk - and they are the same control down to
 * the error handling, so the shape is written once and each limit supplies its
 * field, its bounds and its strings. The alternative was a second copy that
 * would drift the first time either grew a rule.
 *
 * Both live on the project's **Container** page rather than in General settings.
 * They are properties of the containers, they only mean anything alongside their
 * state, and an operator who has come to look at a container is the one who wants
 * to change them; filed under General they read as project metadata.
 *
 * Empty means no override: the container inherits the instance default, which is
 * shown so the field is never a blank that hides a real number.
 */
interface LimitSpec {
	testId: string;
	/** The `projects` column this control writes. */
	field: 'memory_limit_gib' | 'container_disk_gb';
	labelKey: MessageKey;
	helpKey: MessageKey;
	invalidKey: MessageKey;
	inheritedKey: MessageKey;
	overrideKey: MessageKey;
	min: number;
	max?: number;
}

function ProjectContainerLimitSection({ projectId, spec }: { projectId: string; spec: LimitSpec }) {
	const { t } = useI18n();
	const { data: project } = useProject(projectId);
	const { data: settings } = useInstanceSettings();
	const updateProject = useUpdateProject(projectId);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);

	if (!project) return null;
	const inherited =
		spec.field === 'memory_limit_gib'
			? settings?.default_ram_cap_per_container_gb
			: settings?.default_container_disk_gb;
	const current = project[spec.field] ?? null;

	async function save() {
		const trimmed = value.trim();
		setError(null);
		if (trimmed !== '') {
			const parsed = Number(trimmed);
			if (
				!Number.isInteger(parsed) ||
				parsed < spec.min ||
				(spec.max !== undefined && parsed > spec.max)
			) {
				setError(t(spec.invalidKey));
				return;
			}
		}
		try {
			await updateProject.mutateAsync({
				[spec.field]: trimmed === '' ? null : Number(trimmed),
			});
			setEditing(false);
		} catch (e) {
			// The server refuses a memory cap larger than the whole instance budget,
			// because such a container could never be scheduled. That message names
			// the budget, so it belongs on screen rather than being replaced.
			setError((e as Error).message);
		}
	}

	return (
		<section className="border border-border rounded-md p-4 bg-surface" data-testid={spec.testId}>
			<h2 className="text-[13px] font-medium mb-1">{t(spec.labelKey)}</h2>
			<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">{t(spec.helpKey)}</p>
			{editing ? (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						data-testid={`${spec.testId}-input`}
						type="number"
						inputMode="numeric"
						min={spec.min}
						max={spec.max}
						placeholder={inherited ? String(inherited) : ''}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						wrapperClassName="sm:w-40"
					/>
					<Button
						size="sm"
						data-testid={`${spec.testId}-save`}
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
					<span className="text-[13px]" data-testid={`${spec.testId}-value`}>
						{current === null
							? t(spec.inheritedKey, { value: inherited ?? '-' })
							: t(spec.overrideKey, { value: current })}
					</span>
					<Button
						size="sm"
						variant="outline"
						data-testid={`${spec.testId}-edit`}
						onClick={() => {
							setValue(current === null ? '' : String(current));
							setError(null);
							setEditing(true);
						}}
					>
						{t('common.edit')}
					</Button>
				</div>
			)}
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid={`${spec.testId}-error`}>
					{error}
				</p>
			)}
		</section>
	);
}

/** How much memory this project's containers may each take. */
export function ProjectMemoryLimitSection({ projectId }: { projectId: string }) {
	return (
		<ProjectContainerLimitSection
			projectId={projectId}
			spec={{
				testId: 'project-memory-limit',
				field: 'memory_limit_gib',
				labelKey: 'container.memoryLimit.label',
				helpKey: 'container.memoryLimit.help',
				invalidKey: 'container.memoryLimit.invalid',
				inheritedKey: 'container.memoryLimit.inherited',
				overrideKey: 'container.memoryLimit.override',
				min: 1,
			}}
		/>
	);
}

/** How much disk this project's containers each get. */
export function ProjectDiskLimitSection({ projectId }: { projectId: string }) {
	return (
		<ProjectContainerLimitSection
			projectId={projectId}
			spec={{
				testId: 'project-disk-size',
				field: 'container_disk_gb',
				labelKey: 'container.diskSize.label',
				helpKey: 'container.diskSize.help',
				invalidKey: 'container.diskSize.invalid',
				inheritedKey: 'container.diskSize.inherited',
				overrideKey: 'container.diskSize.override',
				min: 2,
				max: 1024,
			}}
		/>
	);
}

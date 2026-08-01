import {
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	HOST_RESERVED_MEMORY_GB,
	MAX_CONTAINER_MEMORY_GB_MAX,
	MAX_CONTAINER_MEMORY_GB_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	SandboxBackend,
	usableMemoryGibForContainers,
} from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	type InstanceSettings,
	useInstanceSettings,
	useUpdateInstanceSettings,
} from '../../hooks/use-instance-settings';
import { useMe } from '../../hooks/use-me';
import { useSandboxBackendInfo } from '../../hooks/use-sandbox-backend-info';
import type { ApiError } from '../../lib/api';
import { type MessageKey, useI18n } from '../../lib/i18n';

const GIB = 1024 ** 3;

function gb(bytes: number): number {
	return Math.round((bytes / GIB) * 10) / 10;
}

const MAX_CONTAINERS_POINTS: readonly MessageKey[] = [
	'concurrency.memoryBudget.point.scope',
	'concurrency.memoryBudget.point.queue',
	'concurrency.memoryBudget.point.automatic',
	'concurrency.memoryBudget.point.range',
];

/**
 * Per-backend caveats, keyed on the backend actually in use.
 *
 * The numbers a provider enforces are its own, so they are stated per provider
 * rather than as a property of managed sandboxes in general - which would be
 * wrong the moment there are two, and wrong in a way nobody notices because the
 * page still reads correctly for whichever one they happen to run. Local Docker
 * is a backend here like any other and gets its own entry.
 *
 * A backend with nothing worth saying maps to `null` rather than to an empty
 * string, so adding one is a decision rather than an omission.
 */
const BACKEND_NOTE: Record<SandboxBackend, MessageKey | null> = {
	[SandboxBackend.Docker]: 'concurrency.backend.dockerNote',
	[SandboxBackend.Daytona]: 'concurrency.backend.daytonaNote',
};

/**
 * Provider names are proper nouns and stay untranslated, so they are literals;
 * the local-daemon wording is a phrase and reuses the Storage card's key rather
 * than adding a second name for one concept. The two are distinguished
 * structurally so neither can be mistaken for the other.
 */
const BACKEND_NAME: Record<SandboxBackend, { key: MessageKey } | { literal: string }> = {
	[SandboxBackend.Docker]: { key: 'settings.sandboxBackend.docker' },
	[SandboxBackend.Daytona]: { literal: 'Daytona' },
};

/**
 * Which backend is running the containers these limits apply to, and what it
 * caps beyond the budget below.
 *
 * On this page rather than only under Storage because the numbers below mean
 * different things per backend: on the local daemon the budget rations the
 * operator's own RAM, and on a managed backend it rations their spend. An
 * operator reading "13 GB" needs to know which.
 */
function ContainerBackendNote() {
	const { t } = useI18n();
	const { data: info } = useSandboxBackendInfo(true);
	if (info === undefined) return null;
	const named = BACKEND_NAME[info.backend];
	const name = 'key' in named ? t(named.key) : named.literal;
	const noteKey = BACKEND_NOTE[info.backend];
	return (
		<p className="text-[13px] text-text-2 mt-1 max-w-[680px]" data-testid="concurrency-backend">
			{t('concurrency.backend.label')} <span className="text-text">{name}</span>
			{noteKey ? ` - ${t(noteKey)}` : null}
		</p>
	);
}

const RAM_CAP_POINTS: readonly MessageKey[] = [
	'concurrency.ramCap.point.limit',
	'concurrency.ramCap.point.overCap',
	'concurrency.ramCap.point.divisor',
	'concurrency.ramCap.point.override',
	'concurrency.ramCap.point.range',
];

/**
 * Each section's explanation is a short bullet list rather than a paragraph -
 * these are reference facts an operator scans, not prose they read. `vars` is
 * shared by every bullet in a section; `t()` drops the placeholders a given
 * bullet doesn't use.
 */
function Points({
	keys,
	vars,
}: {
	keys: readonly MessageKey[];
	vars?: Record<string, string | number>;
}) {
	const { t } = useI18n();
	return (
		<ul className="text-[13px] text-text-2 mb-2.5 max-w-[680px] list-disc pl-4 space-y-1">
			{keys.map((key) => (
				<li key={key}>{t(key, vars)}</li>
			))}
		</ul>
	);
}

function ConcurrencySettingsPage() {
	const { t } = useI18n();
	const { data: me } = useMe();
	const { data: settings } = useInstanceSettings();

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">{t('concurrency.adminOnly')}</p>
		) : (
			<>
				<div className="mb-5">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[22px] font-medium">{t('settings.concurrency')}</h1>
						<InfoTooltip
							label={t('concurrency.about.label')}
							content={t('concurrency.about.content')}
							data-testid="concurrency-info"
						/>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">{t('concurrency.intro')}</p>
					<ContainerBackendNote />
				</div>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label
						className="block text-[13px] font-medium mb-1"
						htmlFor="container-memory-budget-input"
					>
						{t('concurrency.memoryBudget.label')}
					</label>
					<Points
						keys={MAX_CONTAINERS_POINTS}
						vars={{
							min: MAX_CONTAINER_MEMORY_GB_MIN,
							max: MAX_CONTAINER_MEMORY_GB_MAX,
							reserved: HOST_RESERVED_MEMORY_GB,
						}}
					/>
					{settings === undefined ? null : <ContainerMemoryBudgetForm settings={settings} />}
				</section>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label className="block text-[13px] font-medium mb-1" htmlFor="ram-cap-input">
						{t('concurrency.ramCap.label')}
					</label>
					<Points
						keys={RAM_CAP_POINTS}
						vars={{
							min: RAM_CAP_PER_CONTAINER_GB_MIN,
							max: RAM_CAP_PER_CONTAINER_GB_MAX,
							default: DEFAULT_RAM_CAP_PER_CONTAINER_GB,
						}}
					/>
					{settings === undefined ? null : <RamCapForm settings={settings} />}
				</section>
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

function ContainerMemoryBudgetForm({ settings }: { settings: InstanceSettings }) {
	const { t } = useI18n();
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.max_container_memory_gb));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < MAX_CONTAINER_MEMORY_GB_MIN || n > MAX_CONTAINER_MEMORY_GB_MAX) {
			setError(
				t('concurrency.rangeError', {
					min: MAX_CONTAINER_MEMORY_GB_MIN,
					max: MAX_CONTAINER_MEMORY_GB_MAX,
				}),
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ max_container_memory_gb: n });
			setValue(String(result.max_container_memory_gb));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	async function handleReset() {
		setError(null);
		try {
			const result = await updateSettings.mutateAsync({ max_container_memory_gb: null });
			setValue(String(result.max_container_memory_gb));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.max_container_memory_gb);
	// Null host memory means the containers do not run here, so there is no
	// arithmetic to show - the server did not use these numbers either. Rendering
	// a host formula on a managed backend would explain the budget with figures
	// that had no part in it.
	const hostRamBytes = settings.host_total_ram_bytes;
	const hostSwapBytes = settings.host_total_swap_bytes;
	const runsOnHost = hostRamBytes !== null && hostSwapBytes !== null;
	// What is left for task-run containers: the host reserve comes off first, then
	// one container's worth for the assistant chat, which is exempt from the budget
	// and so runs on top of it. Mirrors computeDefaultMaxContainerMemoryGb exactly,
	// so the rendered arithmetic adds up to the number beside it.
	const chatReserve = settings.default_ram_cap_per_container_gb;

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="container-memory-budget-input"
					data-testid="container-memory-budget-input"
					type="number"
					inputMode="numeric"
					min={MAX_CONTAINER_MEMORY_GB_MIN}
					max={MAX_CONTAINER_MEMORY_GB_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="container-memory-budget-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
				{settings.max_container_memory_gb_is_set && (
					<Button
						size="sm"
						variant="outline"
						data-testid="container-memory-budget-reset"
						onClick={handleReset}
						disabled={updateSettings.isPending}
					>
						{t('concurrency.memoryBudget.reset')}
					</Button>
				)}
			</div>
			<p className="text-[13px] text-text-2 mt-1.5" data-testid="container-memory-budget-formula">
				{settings.max_container_memory_gb_is_set
					? t('concurrency.memoryBudget.formulaSet', {
							value: settings.max_container_memory_gb_computed_default,
						})
					: runsOnHost
						? t('concurrency.memoryBudget.formulaAuto', {
								ram: gb(hostRamBytes),
								swap: gb(hostSwapBytes),
								total: Math.round((hostRamBytes + hostSwapBytes) / GIB),
								reserved: HOST_RESERVED_MEMORY_GB,
								chat: chatReserve,
								usable: Math.max(
									0,
									usableMemoryGibForContainers(hostRamBytes, hostSwapBytes) - chatReserve,
								),
							})
						: t('concurrency.memoryBudget.formulaManaged', {
								value: settings.max_container_memory_gb_computed_default,
							})}
			</p>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="container-memory-budget-error">
					{error}
				</p>
			)}
		</>
	);
}

function RamCapForm({ settings }: { settings: InstanceSettings }) {
	const { t } = useI18n();
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.default_ram_cap_per_container_gb));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < RAM_CAP_PER_CONTAINER_GB_MIN || n > RAM_CAP_PER_CONTAINER_GB_MAX) {
			setError(
				t('concurrency.rangeError', {
					min: RAM_CAP_PER_CONTAINER_GB_MIN,
					max: RAM_CAP_PER_CONTAINER_GB_MAX,
				}),
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ default_ram_cap_per_container_gb: n });
			setValue(String(result.default_ram_cap_per_container_gb));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.default_ram_cap_per_container_gb);

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="ram-cap-input"
					data-testid="ram-cap-input"
					type="number"
					inputMode="numeric"
					min={RAM_CAP_PER_CONTAINER_GB_MIN}
					max={RAM_CAP_PER_CONTAINER_GB_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="ram-cap-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="ram-cap-error">
					{error}
				</p>
			)}
		</>
	);
}

export const Route = createFileRoute('/settings/concurrency')({
	component: ConcurrencySettingsPage,
});

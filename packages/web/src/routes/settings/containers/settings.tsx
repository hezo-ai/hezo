import {
	CONTAINER_DISK_GB_MAX,
	CONTAINER_DISK_GB_MIN,
	DEFAULT_CONTAINER_DISK_GB,
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	HOST_RESERVED_MEMORY_GB,
	MAX_CONTAINER_MEMORY_GB_MAX,
	MAX_CONTAINER_MEMORY_GB_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	SandboxBackend,
	sandboxBackendNeedsApiKey,
	usableMemoryGibForContainers,
} from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ManagedSetting } from '../../../components/settings/managed-setting';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { Input } from '../../../components/ui/input';
import { SearchableSelect } from '../../../components/ui/searchable-select';
import {
	type InstanceSettings,
	useInstanceSettings,
	useUpdateInstanceSettings,
} from '../../../hooks/use-instance-settings';
import {
	type SandboxBackendInfo,
	useSandboxBackendInfo,
	useSwitchSandboxBackend,
} from '../../../hooks/use-sandbox-backend-info';
import { toast } from '../../../hooks/use-toast';
import type { ApiError } from '../../../lib/api';
import { type MessageKey, useI18n } from '../../../lib/i18n';
import { backendDisplayName } from '../../../lib/sandbox-backend';

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
 * The one line under each option in the Change dropdown.
 *
 * Deliberately not `BACKEND_NOTE` above: that explains what the *budget* means
 * on a backend already in use, which is a paragraph and reads as a warning. This
 * says what the option **is**, which is what someone choosing needs - and for
 * the local one it is the part that has been wrong: it is Docker or anything
 * Docker-compatible, not Docker specifically.
 */
const BACKEND_OPTION_HINT: Record<SandboxBackend, MessageKey | null> = {
	[SandboxBackend.Docker]: 'settings.sandboxBackend.dockerHint',
	[SandboxBackend.Daytona]: null,
};

function backendOptionHint(
	backend: SandboxBackend,
	t: (key: MessageKey) => string,
): string | undefined {
	const key = BACKEND_OPTION_HINT[backend];
	return key ? t(key) : undefined;
}

/**
 * Which backend is running the containers these limits apply to, and what it
 * caps beyond the budget below.
 *
 * On this page rather than only under Storage because the numbers below mean
 * different things per backend: on the local daemon the budget rations the
 * operator's own RAM, and on a managed backend it rations their spend. An
 * operator reading "13 GB" needs to know which.
 */
/**
 * Choose which backend runs the containers.
 *
 * Switching destroys every running container, so this is the one setting on the
 * page that cannot be a quiet inline save: the confirmation names how many
 * containers and how many in-flight runs the change will end, read from the
 * server rather than described in the abstract. An operator who has nothing
 * running should be able to see that too - "0 containers" is the reassurance
 * that makes the dialog worth reading rather than dismissing.
 *
 * Response-driven: the server preflights the destination and only then destroys
 * anything, so the UI must not show the new backend until the switch has landed.
 */
function BackendSwitcher({ info }: { info: SandboxBackendInfo }) {
	const { t } = useI18n();
	const switchBackend = useSwitchSandboxBackend();
	const [target, setTarget] = useState<SandboxBackend | null>(null);
	const [apiKey, setApiKey] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Offered whenever the destination needs a credential, **including** when one
	// is already on file. Hiding it then read as "this is handled" and was instead
	// a dead end: a stored key that has expired or been revoked is refused by the
	// preflight, and the dialog reporting that refusal was the same dialog that
	// gave no way to supply a working one.
	//
	// Asked of the backend's kind, not its name: every remote container service is
	// reached with an account credential, so naming one here would leave the next
	// one with no field to type its key into.
	const takesKey = target !== null && sandboxBackendNeedsApiKey(target);
	// Required only when there is nothing to fall back on. With a key on file,
	// blank means "keep it" - so rotating is possible without making every switch
	// re-type a key that is already correct.
	const keyRequired = takesKey && !info.credential_configured;
	const canConfirm = !keyRequired || apiKey.trim().length > 0;

	async function handleConfirm() {
		if (!target) return;
		setError(null);
		if (!canConfirm) {
			setError(t('containers.backend.apiKey.required'));
			throw new Error('missing api key');
		}
		try {
			const result = await switchBackend.mutateAsync({
				backend: target,
				daytona_api_key: apiKey.trim() || undefined,
			});
			// The result lives on this page, so the change is its own confirmation -
			// except for the count, which is the part the operator cannot see.
			toast.success(t('containers.backend.switched', { count: result.containers_destroyed ?? 0 }));
			setTarget(null);
			setApiKey('');
		} catch (e) {
			// Kept in the dialog rather than a toast: the operator is mid-decision and
			// the message ("that key was refused") belongs next to the field.
			setError((e as ApiError).message);
			throw e;
		}
	}

	// One row of equal-looking buttons could not say which service was in use -
	// the current one was merely disabled, which reads as "unavailable" at least
	// as readily as "already selected". State the answer, then offer the change.
	const options = info.available.map((backend) => ({
		value: backend,
		label: backendDisplayName(backend, t),
		description: backendOptionHint(backend, t),
	}));

	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[13px] text-text-2">{t('containers.backend.current')}</span>
				<span className="text-[13px] font-medium" data-testid="backend-current">
					{backendDisplayName(info.backend, t)}
				</span>
				<SearchableSelect
					// Two or three services is a list to pick from, not one to search.
					searchable={false}
					options={options}
					value={info.backend}
					onChange={(backend) => {
						setApiKey('');
						setError(null);
						setTarget(backend as SandboxBackend);
					}}
					disabled={switchBackend.isPending}
					align="start"
					testId="backend-change"
					trigger={
						<button
							type="button"
							data-testid="backend-change"
							disabled={switchBackend.isPending}
							className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[13px] text-text-1 hover:border-border-strong disabled:opacity-50 cursor-pointer"
						>
							{t('containers.backend.change')}
							<ChevronDown className="w-3.5 h-3.5 text-text-3" />
						</button>
					}
				/>
			</div>

			<ConfirmDialog
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) setTarget(null);
				}}
				variant="danger"
				title={t('containers.backend.confirm.title', {
					name: target ? backendDisplayName(target, t) : '',
				})}
				description={t('containers.backend.confirm.body', {
					containers: info.impact.containers,
					runs: info.impact.activeRuns,
				})}
				confirmLabel={t('containers.backend.confirm.action')}
				loading={switchBackend.isPending}
				// A disabled confirm would leave the operator guessing why; the guard
				// lives in the handler so the missing key can say so instead.
				onConfirm={handleConfirm}
			>
				{takesKey && target && (
					<div className="flex flex-col gap-1.5">
						<label className="text-[13px] font-medium" htmlFor="backend-api-key-input">
							{t('containers.backend.apiKey.label', { name: backendDisplayName(target, t) })}
						</label>
						<Input
							id="backend-api-key-input"
							data-testid="backend-api-key-input"
							type="password"
							autoComplete="off"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
						/>
						{info.credential_configured && (
							<p className="text-[12px] text-text-2">{t('containers.backend.apiKey.stored')}</p>
						)}
						<p className="text-[12px] text-text-2">{t('containers.backend.apiKey.hint')}</p>
					</div>
				)}
				{error && (
					<p className="text-[13px] text-danger" data-testid="backend-switch-error">
						{error}
					</p>
				)}
			</ConfirmDialog>
		</>
	);
}

function ContainerBackendNote() {
	const { t } = useI18n();
	const { data: info } = useSandboxBackendInfo(true);
	if (info === undefined) return null;
	const name = backendDisplayName(info.backend, t);
	const noteKey = BACKEND_NOTE[info.backend];
	return (
		<p className="text-[13px] text-text-2 mt-1 max-w-[680px]" data-testid="concurrency-backend">
			{t('concurrency.backend.label')} <span className="text-text">{name}</span>
			{noteKey ? ` - ${t(noteKey)}` : null}
		</p>
	);
}

function ContainerBackendSection() {
	const { t } = useI18n();
	const { data: info } = useSandboxBackendInfo(true);
	if (info === undefined) return null;
	return (
		<section className="border border-border rounded-md p-4 bg-surface mb-4">
			<h2 className="text-[13px] font-medium mb-1">{t('containers.backend.sectionLabel')}</h2>
			<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
				{t('containers.backend.sectionHelp')}
			</p>
			<BackendSwitcher info={info} />
		</section>
	);
}

const RAM_CAP_POINTS: readonly MessageKey[] = [
	'concurrency.ramCap.point.limit',
	'concurrency.ramCap.point.overCap',
	'concurrency.ramCap.point.divisor',
	'concurrency.ramCap.point.override',
	'concurrency.ramCap.point.range',
];

const DISK_SIZE_POINTS: readonly MessageKey[] = [
	'concurrency.diskSize.point.allocation',
	'concurrency.diskSize.point.managed',
	'concurrency.diskSize.point.recycle',
	'concurrency.diskSize.point.override',
	'concurrency.diskSize.point.range',
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

/**
 * The limits tab: what a container gets, and where containers run.
 *
 * The page header, the superuser gate and the tabs live in the layout route
 * beside this one - they are shared with the container list, and duplicating a
 * gate is how one of two surfaces ends up ungated.
 */
function ContainerSettingsTab() {
	const { t } = useI18n();
	const { data: settings } = useInstanceSettings();

	return (
		<div className="max-w-[900px]">
			<ContainerBackendNote />
			<div className="mb-4" />

			<ContainerBackendSection />

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
				{settings === undefined ? null : (
					<ManagedSetting pinned={settings.max_container_memory_gb_pinned}>
						<ContainerMemoryBudgetForm settings={settings} />
					</ManagedSetting>
				)}
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
				{settings === undefined ? null : (
					<ManagedSetting pinned={settings.default_ram_cap_per_container_gb_pinned}>
						<RamCapForm settings={settings} />
					</ManagedSetting>
				)}
			</section>

			<section className="border border-border rounded-md p-4 bg-surface mb-4">
				<label className="block text-[13px] font-medium mb-1" htmlFor="container-disk-input">
					{t('concurrency.diskSize.label')}
				</label>
				<Points
					keys={DISK_SIZE_POINTS}
					vars={{
						min: CONTAINER_DISK_GB_MIN,
						max: CONTAINER_DISK_GB_MAX,
						default: DEFAULT_CONTAINER_DISK_GB,
					}}
				/>
				{settings === undefined ? null : (
					<ManagedSetting pinned={settings.default_container_disk_gb_pinned}>
						<ContainerDiskForm settings={settings} />
					</ManagedSetting>
				)}
			</section>
		</div>
	);
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
	// The budget is the total for every container. One container's worth of it is
	// held back for the assistant chat, which is why the split is rendered below
	// the formula rather than folded into it - the reservation applies whether the
	// budget was computed or typed in, so it cannot live in the automatic formula.
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
								usable: usableMemoryGibForContainers(hostRamBytes, hostSwapBytes),
							})
						: t('concurrency.memoryBudget.formulaManaged', {
								value: settings.max_container_memory_gb_computed_default,
							})}
			</p>
			<p className="text-[13px] text-text-2 mt-1" data-testid="container-memory-budget-split">
				{t('concurrency.memoryBudget.split', {
					task: settings.task_container_memory_gb,
					chat: chatReserve,
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

export const Route = createFileRoute('/settings/containers/settings')({
	component: ContainerSettingsTab,
});

/**
 * The instance-wide disk allocation, the sibling of {@link RamCapForm}.
 *
 * Same shape deliberately: an operator reading this page should not have to
 * learn two controls for two limits that behave identically. The one asymmetry
 * is that there is no budget to check it against - Hezo pools memory and does not
 * pool disk, so what bounds this is the provider account's quota, which Hezo
 * cannot see.
 */
function ContainerDiskForm({ settings }: { settings: InstanceSettings }) {
	const { t } = useI18n();
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.default_container_disk_gb));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < CONTAINER_DISK_GB_MIN || n > CONTAINER_DISK_GB_MAX) {
			setError(
				t('concurrency.rangeError', {
					min: CONTAINER_DISK_GB_MIN,
					max: CONTAINER_DISK_GB_MAX,
				}),
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ default_container_disk_gb: n });
			setValue(String(result.default_container_disk_gb));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.default_container_disk_gb);

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="container-disk-input"
					data-testid="container-disk-input"
					type="number"
					inputMode="numeric"
					min={CONTAINER_DISK_GB_MIN}
					max={CONTAINER_DISK_GB_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="container-disk-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="container-disk-error">
					{error}
				</p>
			)}
		</>
	);
}

import {
	CONTAINER_IDLE_TIMEOUT_MIN_MAX,
	CONTAINER_IDLE_TIMEOUT_MIN_MIN,
	DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN,
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	HOST_RESERVED_MEMORY_GB,
	MAX_ACTIVE_CONTAINERS_MAX,
	MAX_ACTIVE_CONTAINERS_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
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
import type { ApiError } from '../../lib/api';
import { type MessageKey, useI18n } from '../../lib/i18n';

const GIB = 1024 ** 3;

function gb(bytes: number): number {
	return Math.round((bytes / GIB) * 10) / 10;
}

const MAX_CONTAINERS_POINTS: readonly MessageKey[] = [
	'concurrency.maxContainers.point.scope',
	'concurrency.maxContainers.point.queue',
	'concurrency.maxContainers.point.automatic',
	'concurrency.maxContainers.point.range',
];

const RAM_CAP_POINTS: readonly MessageKey[] = [
	'concurrency.ramCap.point.limit',
	'concurrency.ramCap.point.overCap',
	'concurrency.ramCap.point.divisor',
	'concurrency.ramCap.point.override',
	'concurrency.ramCap.point.range',
];

const IDLE_TIMEOUT_POINTS: readonly MessageKey[] = [
	'concurrency.idleTimeout.point.duration',
	'concurrency.idleTimeout.point.restart',
	'concurrency.idleTimeout.point.servers',
	'concurrency.idleTimeout.point.range',
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
				</div>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label
						className="block text-[13px] font-medium mb-1"
						htmlFor="max-active-containers-input"
					>
						{t('concurrency.maxContainers.label')}
					</label>
					<Points
						keys={MAX_CONTAINERS_POINTS}
						vars={{
							min: MAX_ACTIVE_CONTAINERS_MIN,
							max: MAX_ACTIVE_CONTAINERS_MAX,
							reserved: HOST_RESERVED_MEMORY_GB,
						}}
					/>
					{settings === undefined ? null : <MaxActiveContainersForm settings={settings} />}
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

				<section className="border border-border rounded-md p-4 bg-surface">
					<label
						className="block text-[13px] font-medium mb-1"
						htmlFor="container-idle-timeout-input"
					>
						{t('concurrency.idleTimeout.label')}
					</label>
					<Points
						keys={IDLE_TIMEOUT_POINTS}
						vars={{
							min: CONTAINER_IDLE_TIMEOUT_MIN_MIN,
							max: CONTAINER_IDLE_TIMEOUT_MIN_MAX,
							default: DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN,
						}}
					/>
					{settings === undefined ? null : <IdleTimeoutForm settings={settings} />}
				</section>
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

function MaxActiveContainersForm({ settings }: { settings: InstanceSettings }) {
	const { t } = useI18n();
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.max_active_containers));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < MAX_ACTIVE_CONTAINERS_MIN || n > MAX_ACTIVE_CONTAINERS_MAX) {
			setError(
				t('concurrency.rangeError', {
					min: MAX_ACTIVE_CONTAINERS_MIN,
					max: MAX_ACTIVE_CONTAINERS_MAX,
				}),
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ max_active_containers: n });
			setValue(String(result.max_active_containers));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	async function handleReset() {
		setError(null);
		try {
			const result = await updateSettings.mutateAsync({ max_active_containers: null });
			setValue(String(result.max_active_containers));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.max_active_containers);
	const ram = gb(settings.host_total_ram_bytes);
	const swap = gb(settings.host_total_swap_bytes);
	const total = Math.round((settings.host_total_ram_bytes + settings.host_total_swap_bytes) / GIB);
	const usable = usableMemoryGibForContainers(
		settings.host_total_ram_bytes,
		settings.host_total_swap_bytes,
	);

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="max-active-containers-input"
					data-testid="max-active-containers-input"
					type="number"
					inputMode="numeric"
					min={MAX_ACTIVE_CONTAINERS_MIN}
					max={MAX_ACTIVE_CONTAINERS_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="max-active-containers-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
				{settings.max_active_containers_is_set && (
					<Button
						size="sm"
						variant="outline"
						data-testid="max-active-containers-reset"
						onClick={handleReset}
						disabled={updateSettings.isPending}
					>
						{t('concurrency.maxContainers.reset')}
					</Button>
				)}
			</div>
			<p className="text-[13px] text-text-2 mt-1.5" data-testid="max-active-containers-formula">
				{settings.max_active_containers_is_set
					? t('concurrency.maxContainers.formulaSet', {
							value: settings.max_active_containers_computed_default,
						})
					: t('concurrency.maxContainers.formulaAuto', {
							ram,
							swap,
							total,
							reserved: HOST_RESERVED_MEMORY_GB,
							usable,
							cap: settings.default_ram_cap_per_container_gb,
							result: settings.max_active_containers_computed_default,
						})}
			</p>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="max-active-containers-error">
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

function IdleTimeoutForm({ settings }: { settings: InstanceSettings }) {
	const { t } = useI18n();
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.container_idle_timeout_min));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (
			Number.isNaN(n) ||
			n < CONTAINER_IDLE_TIMEOUT_MIN_MIN ||
			n > CONTAINER_IDLE_TIMEOUT_MIN_MAX
		) {
			setError(
				t('concurrency.rangeError', {
					min: CONTAINER_IDLE_TIMEOUT_MIN_MIN,
					max: CONTAINER_IDLE_TIMEOUT_MIN_MAX,
				}),
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ container_idle_timeout_min: n });
			setValue(String(result.container_idle_timeout_min));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.container_idle_timeout_min);

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="container-idle-timeout-input"
					data-testid="container-idle-timeout-input"
					type="number"
					inputMode="numeric"
					min={CONTAINER_IDLE_TIMEOUT_MIN_MIN}
					max={CONTAINER_IDLE_TIMEOUT_MIN_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="container-idle-timeout-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />}{' '}
					{t('common.save')}
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="container-idle-timeout-error">
					{error}
				</p>
			)}
		</>
	);
}

export const Route = createFileRoute('/settings/concurrency')({
	component: ConcurrencySettingsPage,
});

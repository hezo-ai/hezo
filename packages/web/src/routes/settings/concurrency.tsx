import {
	CONTAINER_IDLE_TIMEOUT_MIN_MAX,
	CONTAINER_IDLE_TIMEOUT_MIN_MIN,
	DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN,
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	MAX_ACTIVE_CONTAINERS_MAX,
	MAX_ACTIVE_CONTAINERS_MIN,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	SYSTEM_RESERVE_GB,
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

const GIB = 1024 ** 3;

function gb(bytes: number): number {
	return Math.round((bytes / GIB) * 10) / 10;
}

function ConcurrencySettingsPage() {
	const { data: me } = useMe();
	const { data: settings } = useInstanceSettings();

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Concurrency settings are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[22px] font-medium">Concurrency</h1>
						<InfoTooltip
							label="About concurrency"
							content="How many project containers may run at once and how much memory each may use - together they bound the total resources Hezo takes on this machine."
							data-testid="concurrency-info"
						/>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						Project containers start on demand when an agent run or an assistant chat needs them,
						and stop again after sitting idle. These settings bound how many can be active at once
						and how much memory each may use, so a burst of agent activity can never take down the
						machine.
					</p>
				</div>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label
						className="block text-[13px] font-medium mb-1"
						htmlFor="max-active-containers-input"
					>
						Maximum active containers
					</label>
					<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
						The maximum number of project containers that may be active at the same time, including
						the assistant chat's container. Combined with the RAM cap below, this bounds how much
						memory Hezo can use at once: total demand never exceeds this number times the cap. An
						agent run whose project container is already active starts immediately; one that needs
						another container waits in the queue until a container goes idle. The assistant chat
						always starts, even at the limit. Must be between {MAX_ACTIVE_CONTAINERS_MIN} and{' '}
						{MAX_ACTIVE_CONTAINERS_MAX}; leave on automatic to size it from this host's memory.
					</p>
					{settings === undefined ? null : <MaxActiveContainersForm settings={settings} />}
				</section>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label className="block text-[13px] font-medium mb-1" htmlFor="ram-cap-input">
						RAM cap per container (GB)
					</label>
					<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
						The memory limit applied to every project container. A container that grows past this
						cap is stopped by Hezo (or has its biggest process killed by the kernel) instead of
						taking down the whole server. It is also the divisor of the automatic container limit
						above: raising the cap gives each container more headroom but lowers how many run at
						once. Projects that need more memory can override it on their own Settings page. Must be
						between {RAM_CAP_PER_CONTAINER_GB_MIN} and {RAM_CAP_PER_CONTAINER_GB_MAX}; defaults to{' '}
						{DEFAULT_RAM_CAP_PER_CONTAINER_GB}.
					</p>
					{settings === undefined ? null : <RamCapForm settings={settings} />}
				</section>

				<section className="border border-border rounded-md p-4 bg-surface">
					<label
						className="block text-[13px] font-medium mb-1"
						htmlFor="container-idle-timeout-input"
					>
						Container idle timeout (minutes)
					</label>
					<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
						How long a project's container keeps running after its last activity (agent runs and
						assistant chat) before it is stopped automatically. Containers start again on demand the
						moment a run or a chat needs them. Stopping a container also stops any dev or preview
						servers running inside it. Set 0 to keep containers always on. Must be between{' '}
						{CONTAINER_IDLE_TIMEOUT_MIN_MIN} and {CONTAINER_IDLE_TIMEOUT_MIN_MAX}; defaults to{' '}
						{DEFAULT_CONTAINER_IDLE_TIMEOUT_MIN}.
					</p>
					{settings === undefined ? null : <IdleTimeoutForm settings={settings} />}
				</section>
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

function MaxActiveContainersForm({ settings }: { settings: InstanceSettings }) {
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.max_active_containers));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < MAX_ACTIVE_CONTAINERS_MIN || n > MAX_ACTIVE_CONTAINERS_MAX) {
			setError(
				`Enter a whole number between ${MAX_ACTIVE_CONTAINERS_MIN} and ${MAX_ACTIVE_CONTAINERS_MAX}.`,
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
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
				{settings.max_active_containers_is_set && (
					<Button
						size="sm"
						variant="outline"
						data-testid="max-active-containers-reset"
						onClick={handleReset}
						disabled={updateSettings.isPending}
					>
						Reset to automatic
					</Button>
				)}
			</div>
			<p className="text-[13px] text-text-2 mt-1.5" data-testid="max-active-containers-formula">
				{settings.max_active_containers_is_set
					? `Set explicitly - the automatic value for this host would be ${settings.max_active_containers_computed_default}.`
					: `Automatic: this host has ${ram} GB RAM + ${swap} GB swap (~${total} GB), less ${SYSTEM_RESERVE_GB} GB for the system and ${settings.default_ram_cap_per_container_gb} GB for the chat container, / ${settings.default_ram_cap_per_container_gb} GB per container = ${settings.max_active_containers_computed_default}.`}
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
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.default_ram_cap_per_container_gb));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n) || n < RAM_CAP_PER_CONTAINER_GB_MIN || n > RAM_CAP_PER_CONTAINER_GB_MAX) {
			setError(
				`Enter a whole number between ${RAM_CAP_PER_CONTAINER_GB_MIN} and ${RAM_CAP_PER_CONTAINER_GB_MAX}.`,
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
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
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
				`Enter a whole number between ${CONTAINER_IDLE_TIMEOUT_MIN_MIN} and ${CONTAINER_IDLE_TIMEOUT_MIN_MAX}.`,
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
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
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

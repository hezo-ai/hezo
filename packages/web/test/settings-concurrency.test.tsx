import { setHostMemoryForTest } from '@hezo/server/src/lib/host-memory';
import { waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

const GIB = 1024 ** 3;

afterEach(() => setHostMemoryForTest(null));

test('concurrency settings page shows the computed default, saves, and resets to automatic', async () => {
	// The incident's reference host: ~2GB RAM + 6GB swap → 8GB, less the 1GB
	// system reserve = 7 usable, / 2GB cap = 3.
	setHostMemoryForTest({ totalRamBytes: 1.92 * GIB, totalSwapBytes: 6 * GIB });

	const { findByTestId, findByRole, queryByTestId, user } = await renderApp({
		initialPath: '/settings/concurrency',
	});

	await findByRole('heading', { name: 'Concurrency' });

	// Unset → the effective value is the host-memory-computed default, which
	// reserves for the system and for the chat's container before dividing:
	// 8 GiB - 1 - 2, over 2 GB per container.
	const maxInput = (await findByTestId('max-active-containers-input')) as HTMLInputElement;
	expect(maxInput.value).toBe('2');
	const formula = await findByTestId('max-active-containers-formula');
	expect(formula.textContent).toContain('= 2');
	// Both reserves are spelled out, not just applied, so the operator can see
	// where the memory went - otherwise the arithmetic on screen does not add up
	// and reads as a bug.
	expect(formula.textContent).toContain('1 GB for the system');
	expect(formula.textContent).toContain('2 GB for the assistant');
	expect(queryByTestId('max-active-containers-reset')).toBeNull();

	// An explicit value wins and offers a reset back to automatic.
	await user.clear(maxInput);
	await user.type(maxInput, '7');
	await user.click(await findByTestId('max-active-containers-save'));
	await waitFor(() => expect(maxInput.value).toBe('7'));
	const reset = await findByTestId('max-active-containers-reset');

	const { apiBase, token } = getTestContext();
	const auth = { Authorization: `Bearer ${token}` };
	let res = await apiBase('/api/instance-settings', { headers: auth });
	let data = (await res.json()).data;
	expect(data.max_active_containers).toBe(7);
	expect(data.max_active_containers_is_set).toBe(true);

	await user.click(reset);
	await waitFor(() => expect(maxInput.value).toBe('2'));
	res = await apiBase('/api/instance-settings', { headers: auth });
	data = (await res.json()).data;
	expect(data.max_active_containers).toBe(2);
	expect(data.max_active_containers_is_set).toBe(false);
});

test('raising the ram cap lowers the automatic container limit and persists', async () => {
	setHostMemoryForTest({ totalRamBytes: 1.92 * GIB, totalSwapBytes: 6 * GIB });

	const { findByTestId, findByRole, user } = await renderApp({
		initialPath: '/settings/concurrency',
	});
	await findByRole('heading', { name: 'Concurrency' });

	const ramInput = (await findByTestId('ram-cap-input')) as HTMLInputElement;
	expect(ramInput.value).toBe('2');
	await user.clear(ramInput);
	await user.type(ramInput, '3');
	await user.click(await findByTestId('ram-cap-save'));
	await waitFor(() => expect(ramInput.value).toBe('3'));

	// The cap feeds both the chat reserve and the divisor: (8 - 1 - 3) / 3 floors
	// to 1. That is also the MIN clamp, so the rendered reserve is asserted too -
	// otherwise this would pass with the division broken.
	const formula = await findByTestId('max-active-containers-formula');
	await waitFor(() => expect(formula.textContent).toContain('= 1'));
	expect(formula.textContent).toContain('3 GB for the assistant');

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = (await res.json()).data;
	expect(data.default_ram_cap_per_container_gb).toBe(3);
	expect(data.max_active_containers).toBe(1);
});

test('saves the container idle timeout, including 0 for always-on', async () => {
	const { findByTestId, findByRole, user } = await renderApp({
		initialPath: '/settings/concurrency',
	});
	await findByRole('heading', { name: 'Concurrency' });

	const input = (await findByTestId('container-idle-timeout-input')) as HTMLInputElement;
	expect(input.value).toBe('15');
	await user.clear(input);
	await user.type(input, '0');
	await user.click(await findByTestId('container-idle-timeout-save'));
	await waitFor(() => expect(input.value).toBe('0'));

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect((await res.json()).data.container_idle_timeout_min).toBe(0);
});

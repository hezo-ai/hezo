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

	// Unset → the effective value is the host-memory-computed default.
	const maxInput = (await findByTestId('max-active-containers-input')) as HTMLInputElement;
	expect(maxInput.value).toBe('3');
	const formula = await findByTestId('max-active-containers-formula');
	expect(formula.textContent).toContain('= 3');
	// The reserve is spelled out, so the operator can see where the memory went.
	expect(formula.textContent).toContain('1 GB');
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
	await waitFor(() => expect(maxInput.value).toBe('3'));
	res = await apiBase('/api/instance-settings', { headers: auth });
	data = (await res.json()).data;
	expect(data.max_active_containers).toBe(3);
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

	// The automatic limit follows the new divisor: 7 usable GB / 3GB = 2. A 4GB
	// cap would floor to 1, which is also the MIN clamp, so the assertion would
	// pass even with the division broken.
	const formula = await findByTestId('max-active-containers-formula');
	await waitFor(() => expect(formula.textContent).toContain('= 2'));

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = (await res.json()).data;
	expect(data.default_ram_cap_per_container_gb).toBe(3);
	expect(data.max_active_containers).toBe(2);
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

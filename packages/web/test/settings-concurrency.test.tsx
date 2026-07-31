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

	// Unset → the effective value is the host-memory-computed default: 8 GiB less
	// 1 GB for the system and one 2 GB container for the chat, which runs on top
	// of the budget rather than inside it.
	const maxInput = (await findByTestId('container-memory-budget-input')) as HTMLInputElement;
	expect(maxInput.value).toBe('5');
	const formula = await findByTestId('container-memory-budget-formula');
	expect(formula.textContent).toContain('= 5 GB');
	// Both reserves are spelled out, not just applied, so the operator can see
	// where the memory went - otherwise the arithmetic on screen does not add up
	// and reads as a bug.
	expect(formula.textContent).toContain('1 GB for the system');
	expect(formula.textContent).toContain('2 GB for the assistant');
	expect(queryByTestId('container-memory-budget-reset')).toBeNull();

	// An explicit value wins and offers a reset back to automatic.
	await user.clear(maxInput);
	await user.type(maxInput, '14');
	await user.click(await findByTestId('container-memory-budget-save'));
	await waitFor(() => expect(maxInput.value).toBe('14'));
	const reset = await findByTestId('container-memory-budget-reset');

	const { apiBase, token } = getTestContext();
	const auth = { Authorization: `Bearer ${token}` };
	let res = await apiBase('/api/instance-settings', { headers: auth });
	let data = (await res.json()).data;
	expect(data.max_container_memory_gb).toBe(14);
	expect(data.max_container_memory_gb_is_set).toBe(true);

	await user.click(reset);
	await waitFor(() => expect(maxInput.value).toBe('5'));
	res = await apiBase('/api/instance-settings', { headers: auth });
	data = (await res.json()).data;
	expect(data.max_container_memory_gb).toBe(5);
	expect(data.max_container_memory_gb_is_set).toBe(false);
});

test('raising the ram cap lowers the automatic memory budget and persists', async () => {
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

	// The cap no longer divides anything - it is the chat's reserve, held back up
	// front: 8 - 1 - 3 = 4. The rendered reserve is asserted too, so the number on
	// screen and the arithmetic behind it cannot drift apart.
	const formula = await findByTestId('container-memory-budget-formula');
	await waitFor(() => expect(formula.textContent).toContain('= 4 GB'));
	expect(formula.textContent).toContain('3 GB for the assistant');

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = (await res.json()).data;
	expect(data.default_ram_cap_per_container_gb).toBe(3);
	expect(data.max_container_memory_gb).toBe(4);
});

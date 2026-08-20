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
		initialPath: '/settings/containers/settings',
	});

	await findByRole('heading', { name: 'Containers' });

	// Unset → the effective value is the host-memory-computed default: 8 GiB less
	// 1 GB for the system. This is the TOTAL for every container; the chat's share
	// comes out of it below rather than before it.
	const maxInput = (await findByTestId('container-memory-budget-input')) as HTMLInputElement;
	expect(maxInput.value).toBe('7');
	// The backend running the containers is named, with only its own caveats: the
	// numbers a provider enforces are its own, and stating one provider's in the
	// general prose would read as a property of every backend. It is named for what
	// it is - a local container service - rather than for Docker specifically,
	// since a Docker-compatible runtime is equally supported.
	const backend = await findByTestId('concurrency-backend');
	expect(backend.textContent).toContain('Local container service');
	expect(backend.textContent).toContain('share this machine');
	expect(backend.textContent).not.toContain('Daytona');

	const formula = await findByTestId('container-memory-budget-formula');
	expect(formula.textContent).toContain('= 7 GB');
	// The system reserve is spelled out, not just applied, so the operator can see
	// where the memory went - otherwise the arithmetic on screen does not add up
	// and reads as a bug.
	expect(formula.textContent).toContain('1 GB for the system');
	// The chat's share is its own line, because it applies to a hand-typed budget
	// as much as to this computed one and so cannot live inside the formula.
	const split = await findByTestId('container-memory-budget-split');
	expect(split.textContent).toContain('5 GB for task runs');
	expect(split.textContent).toContain('2 GB held back for the assistant');
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
	await waitFor(() => expect(maxInput.value).toBe('7'));
	res = await apiBase('/api/instance-settings', { headers: auth });
	data = (await res.json()).data;
	expect(data.max_container_memory_gb).toBe(7);
	expect(data.task_container_memory_gb).toBe(5);
	expect(data.max_container_memory_gb_is_set).toBe(false);
});

test('raising the ram cap lowers the automatic memory budget and persists', async () => {
	setHostMemoryForTest({ totalRamBytes: 1.92 * GIB, totalSwapBytes: 6 * GIB });

	const { findByTestId, findByRole, user } = await renderApp({
		initialPath: '/settings/containers/settings',
	});
	await findByRole('heading', { name: 'Containers' });

	const ramInput = (await findByTestId('ram-cap-input')) as HTMLInputElement;
	expect(ramInput.value).toBe('2');
	await user.clear(ramInput);
	await user.type(ramInput, '3');
	await user.click(await findByTestId('ram-cap-save'));
	await waitFor(() => expect(ramInput.value).toBe('3'));

	// The cap does not divide anything - it is the chat's reserve. So the TOTAL is
	// fixed by host memory (8 - 1 = 7) while the TASK share moves with the cap
	// (7 - 3 = 4). Both are asserted, so the numbers on screen and the arithmetic
	// behind them cannot drift apart.
	const formula = await findByTestId('container-memory-budget-formula');
	await waitFor(() => expect(formula.textContent).toContain('= 7 GB'));
	const split = await findByTestId('container-memory-budget-split');
	await waitFor(() => expect(split.textContent).toContain('4 GB for task runs'));
	expect(split.textContent).toContain('3 GB held back for the assistant');

	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = (await res.json()).data;
	expect(data.default_ram_cap_per_container_gb).toBe(3);
	expect(data.max_container_memory_gb).toBe(7);
	expect(data.task_container_memory_gb).toBe(4);
});

test('the service panel names the current service and offers the rest behind Change', async () => {
	// The row of equal-looking buttons this replaced could not say which service
	// was in use: the current one was merely disabled, which reads as
	// "unavailable" at least as readily as "already selected".
	const { findByTestId, user } = await renderApp({
		initialPath: '/settings/containers/settings',
	});

	const current = await findByTestId('backend-current');
	expect(current.textContent).toBe('Local container service');

	await user.click(await findByTestId('backend-change'));

	// Radix renders the options into a portal on document.body.
	const local = await findByTestId('backend-change-option-docker');
	// The option says what it *is* - not Docker specifically, since anything
	// Docker-compatible on this machine works the same way.
	expect(local.textContent).toContain('Local container service');
	expect(local.textContent).toContain('Docker-compatible');
	await findByTestId('backend-change-option-daytona');
});

test('switching the container service warns with real numbers and needs a key', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({
		initialPath: '/settings/containers/settings',
	});

	await user.click(await findByTestId('backend-change'));
	await user.click(await findByTestId('backend-change-option-daytona'));

	// The confirmation states what will be destroyed rather than warning in the
	// abstract - a fresh instance has nothing running, and "0" is exactly the
	// reassurance that makes the dialog worth reading instead of dismissing.
	const dialog = document.body;
	expect(dialog.textContent).toContain('destroys 0 running container');
	expect(dialog.textContent).toContain('ends 0 agent run');

	// Daytona has no stored credential here, so the key field is part of the
	// decision rather than a separate step the operator discovers afterwards.
	const keyInput = getByTestId('backend-api-key-input') as HTMLInputElement;
	expect(keyInput.type).toBe('password');
});

test('offers the key field even when one is already stored, so an expired key can be replaced', async () => {
	// The dead end this closes: hiding the field once *any* key was on file read
	// as "handled", but a stored key that has expired or been revoked is refused
	// by the preflight - and the dialog reporting that refusal was the same
	// dialog that gave no way to supply a working one. The only escape was a
	// launch flag, which is not a thing the Containers page should require.
	const { findByTestId, getByTestId, user } = await renderApp({
		initialPath: '/settings/containers/settings',
		seed: async (ctx) => {
			// Only existence matters here: `credential_configured` comes from
			// hasDaytonaApiKey, which never decrypts.
			await ctx.db.query(
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts, allow_body_substitution)
				 VALUES ('HEZO_DAYTONA_API_KEY', 'stale-ciphertext', 'api_token', $1, false, false)`,
				[[]],
			);
		},
	});

	await user.click(await findByTestId('backend-change'));
	await user.click(await findByTestId('backend-change-option-daytona'));

	const keyInput = getByTestId('backend-api-key-input') as HTMLInputElement;
	expect(keyInput.type).toBe('password');
	// Blank is legitimate here - it means "keep the stored key" - so the dialog
	// says which of the two it is doing rather than leaving the operator to guess.
	expect(document.body.textContent).toContain('A key is already stored');
});

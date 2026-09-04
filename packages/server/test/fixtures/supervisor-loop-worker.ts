import { existsSync, writeFileSync } from 'node:fs';
import { runSupervisor } from '../../src/supervisor';

const [mode, stateFile, reportFile, dataDir] = process.argv.slice(2);
const key = 'ab'.repeat(32);

if (process.env.HEZO_WORKER === '1') {
	if (mode === 'update' && !existsSync(stateFile)) {
		writeFileSync(stateFile, 'relaunch');
		process.send?.({ type: 'hezo:unlock-key', unlockKeyHex: key });
		setTimeout(() => process.exit(75), 20);
	} else {
		let answered = false;
		process.on('message', (message) => {
			if (
				message &&
				typeof message === 'object' &&
				(message as { type?: unknown }).type === 'hezo:unlock-key'
			) {
				answered = true;
				writeFileSync(reportFile, (message as { unlockKeyHex: string }).unlockKeyHex);
				process.exit(mode === 'update' ? 0 : 2);
			}
		});
		process.send?.({ type: 'hezo:request-unlock-key' });
		setTimeout(() => {
			if (!answered) writeFileSync(reportFile, 'none');
			process.exit(0);
		}, 100);
	}
} else {
	await runSupervisor(dataDir);
}

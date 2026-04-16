import { spawn } from 'node:child_process';
import { logger } from '../logger';

const log = logger.child('image-builder');

export type BuildLogStream = 'stdout' | 'stderr';
export type BuildOnLine = (stream: BuildLogStream, text: string) => void;

export async function buildImageViaCli(
	image: string,
	contextPath: string,
	dockerfilePath: string,
	onLine?: BuildOnLine,
): Promise<void> {
	log.info(`Building ${image} from ${dockerfilePath}`);

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn('docker', ['build', '-t', image, '-f', dockerfilePath, contextPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const relay = (stream: NodeJS.ReadableStream, streamName: BuildLogStream) => {
			let buffer = '';
			stream.setEncoding('utf8');
			stream.on('data', (chunk: string) => {
				buffer += chunk;
				for (;;) {
					const idx = buffer.indexOf('\n');
					if (idx === -1) break;
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (line.length > 0) {
						log.debug(line);
						onLine?.(streamName, line);
					}
				}
			});
			stream.on('end', () => {
				if (buffer.length > 0) {
					log.debug(buffer);
					onLine?.(streamName, buffer);
				}
			});
		};

		relay(child.stdout, 'stdout');
		relay(child.stderr, 'stderr');

		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				log.info(`Built ${image}`);
				resolvePromise();
			} else {
				reject(new Error(`docker build exited with code ${code}`));
			}
		});
	});
}

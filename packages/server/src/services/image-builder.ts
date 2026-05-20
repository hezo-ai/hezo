import { spawn } from 'node:child_process';
import { logger } from '../logger';

const log = logger.child('image-builder');

export type BuildLogStream = 'stdout' | 'stderr';
export type BuildOnLine = (stream: BuildLogStream, text: string) => void;

export interface BuildOptions {
	onLine?: BuildOnLine;
	labels?: Record<string, string>;
}

export async function buildImageViaCli(
	image: string,
	contextPath: string,
	dockerfilePath: string,
	options: BuildOptions | BuildOnLine | undefined = undefined,
): Promise<void> {
	const opts: BuildOptions = typeof options === 'function' ? { onLine: options } : (options ?? {});
	const onLine = opts.onLine;
	log.info(`Building ${image} from ${dockerfilePath}`);

	const args = ['build', '-t', image, '-f', dockerfilePath];
	if (opts.labels) {
		for (const [key, value] of Object.entries(opts.labels)) {
			args.push('--label', `${key}=${value}`);
		}
	}
	args.push(contextPath);

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn('docker', args, {
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

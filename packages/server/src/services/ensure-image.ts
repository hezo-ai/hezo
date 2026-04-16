import type { DockerClient } from './docker';
import { type BuildOnLine, buildImageViaCli } from './image-builder';
import { type ResolvedLocalImage, resolveLocalImage } from './image-registry';

export interface EnsureImageDeps {
	resolveLocal?: (image: string) => ResolvedLocalImage | null;
	build?: (
		image: string,
		contextPath: string,
		dockerfilePath: string,
		onLine?: BuildOnLine,
	) => Promise<void>;
	onLine?: BuildOnLine;
}

export async function ensureImage(
	docker: DockerClient,
	image: string,
	deps: EnsureImageDeps = {},
): Promise<void> {
	if (await docker.imageExists(image)) return;

	const resolver = deps.resolveLocal ?? resolveLocalImage;
	const local = resolver(image);
	if (local) {
		const builder = deps.build ?? buildImageViaCli;
		await builder(local.image, local.context, local.dockerfile, deps.onLine);
		return;
	}

	await docker.pullImage(image);
}

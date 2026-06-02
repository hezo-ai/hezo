import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';

// Bundle the built web frontend (`packages/web/dist`) into a single JSON map
// that the server imports via a literal dynamic import, so `bun build --compile`
// embeds it into the binary's virtual FS and the assets are served from memory
// — no runtime extraction to a temp dir. Binary files are base64-encoded since
// JSON can't carry raw bytes.
const webDist = join(import.meta.dir, '..', '..', 'web', 'dist');
const outputPath = join(import.meta.dir, '..', 'src', 'static-bundle.json');

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.eot': 'application/vnd.ms-fontobject',
	'.wasm': 'application/wasm',
};

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

const files = await walk(webDist);
const bundle: Record<string, { type: string; b64: string }> = {};
for (const full of files) {
	const key = `/${relative(webDist, full).split(sep).join('/')}`;
	const bytes = await readFile(full);
	bundle[key] = {
		type: MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
		b64: bytes.toString('base64'),
	};
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(bundle));
console.log(`Bundled ${files.length} static asset(s) → ${outputPath}`);

// `import x from './foo.wasm' with { type: 'file' }` resolves to the embedded
// file's path string in a Bun-compiled binary. These ambient declarations let
// tsc accept the imports without the generated asset files existing on disk
// (they're produced by `scripts/bundle-pglite.ts` only for binary builds).
declare module '*.wasm' {
	const path: string;
	export default path;
}
declare module '*.data' {
	const path: string;
	export default path;
}
declare module '*.tar.gz' {
	const path: string;
	export default path;
}

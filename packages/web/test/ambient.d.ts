// Component tests import the server app in-process for a real backend; that
// pulls in the server's embedded binary-asset imports. Mirror the server's
// `asset-modules.d.ts` so the web typecheck (which now covers `test/`) resolves
// them.
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

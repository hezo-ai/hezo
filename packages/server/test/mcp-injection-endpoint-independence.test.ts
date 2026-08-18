// The pre-claim preflight builds a runtime's MCP injection before the tunnel
// exists, so it uses a stand-in loopback port. That is only sound if no adapter
// and no part of `validateInjection` reads the port - a claim, and this is what
// pins it rather than a comment asserting it.

import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildMcpInjection,
	HEZO_MCP_SERVER_NAME,
	RUNTIME_ADAPTERS,
} from '../src/services/runtime-adapters';
import {
	TUNNEL_PORT_BASE,
	TUNNEL_PORT_RANGE,
	tunnelRunEndpoints,
} from '../src/services/sandbox/endpoints';

const HOME = '/workspace/.hezo/subscription/codex/run-1';

function injectionAt(runtime: AgentRuntime, mcpPort: number) {
	const endpoints = tunnelRunEndpoints({
		proxy: mcpPort - 1,
		mcp: mcpPort,
		ssh: mcpPort + 1,
	});
	const requiresHome = RUNTIME_ADAPTERS[runtime].capabilities.requiresHomeDir;
	return buildMcpInjection(
		runtime,
		[
			{
				kind: 'http',
				name: HEZO_MCP_SERVER_NAME,
				url: `${endpoints.hezoBaseUrl}/mcp`,
				bearerToken: 'jwt.body.signature',
			},
		],
		{
			hostHomeDir: requiresHome ? HOME : null,
			containerHomeDir: requiresHome ? HOME : null,
			provider: AiProvider.Anthropic,
			runModel: null,
			projectDocSlugs: [],
			stopJudge: true,
			systemPrompt: null,
		},
	);
}

describe('MCP injection is independent of the tunnel port', () => {
	const low = TUNNEL_PORT_BASE + 1;
	const high = TUNNEL_PORT_BASE + TUNNEL_PORT_RANGE - 1;

	for (const runtime of Object.values(AgentRuntime)) {
		it(`${runtime} differs only in the port digits`, () => {
			const a = JSON.stringify(injectionAt(runtime, low));
			const b = JSON.stringify(injectionAt(runtime, high));
			// Substituting one port for the other must make the two identical. If an
			// adapter ever branched on a port, or embedded one somewhere the
			// substitution does not reach, this is where it shows up.
			const normalise = (s: string, port: number) =>
				s
					.split(String(port))
					.join('<MCP>')
					.split(String(port - 1))
					.join('<PROXY>')
					.split(String(port + 1))
					.join('<SSH>');
			expect(normalise(a, low)).toBe(normalise(b, high));
		});

		it(`${runtime} accepts the preflight's stand-in ports`, () => {
			// The preflight would otherwise refuse every run on this runtime.
			expect(() => injectionAt(runtime, low)).not.toThrow();
		});
	}
});

import { SandboxBackend as Backend, SANDBOX_BACKEND_KIND, type SandboxBackend } from '@hezo/shared';

/**
 * What an agent is told about the machine its container runs on.
 *
 * An agent debugging a failure cannot tell the difference between "this command
 * is wrong" and "this container's network will not carry that protocol", and it
 * has no way to find out - so it retries, or reports a broken tool, or invents a
 * workaround for a constraint it has misdiagnosed. The Daytona case is the
 * worked example: `ssh user@host` fails there for a reason no error message
 * explains, on a backend the agent was never told it was running on.
 *
 * A `Record<SandboxBackend, …>` deliberately, per **Table over branch**: adding a
 * container service is a **compile error** until it states what an agent can and
 * cannot reach from inside it. That is the enforcement behind the AGENTS.md rule
 * - a new backend cannot ship with agents silently inheriting another provider's
 * network assumptions.
 *
 * Every claim here is **measured against the live provider**, never inferred
 * from its docs (see the "probe the provider" rule). Where a figure or a
 * behaviour is provider-specific it also belongs on that provider's own docs
 * page, so an operator and an agent are reading the same facts.
 */
export interface SandboxAgentEnvironment {
	/** How the service is named to an agent. A proper noun, or a plain phrase. */
	label: string;
	/** One line on where the container actually runs. */
	location: string;
	/**
	 * What outbound network the container has, in an agent's terms: what works,
	 * what does not, and what to reach for instead. Rendered as bullet lines.
	 */
	egress: string[];
}

export const SANDBOX_AGENT_ENVIRONMENTS: Record<SandboxBackend, SandboxAgentEnvironment> = {
	[Backend.Docker]: {
		label: 'local Docker (or a Docker-compatible runtime)',
		location: "Your container runs on the operator's own machine.",
		egress: [
			'Outbound network is whatever that machine allows, so it is usually unrestricted - ' +
				'HTTPS, SSH, and other TCP protocols all work unless the operator has a firewall of their own.',
			"Requests to hosts your credentials and connectors are scoped to pass through Hezo's " +
				'egress proxy, which is what substitutes `__HEZO_SECRET_<NAME>__` placeholders; ' +
				'everything else connects direct. A request that reaches a credentialed host without ' +
				'the proxy carries the unsubstituted placeholder and simply fails upstream.',
		],
	},
	[Backend.Daytona]: {
		label: 'Daytona',
		location: "Your container is a managed sandbox on Daytona's machines, not on the operator's.",
		egress: [
			'**Raw TCP protocols are blocked, including SSH.** `ssh` fails on every port: port 22 is ' +
				'dropped (you see a connect timeout) and port 443 accepts the connection and then ' +
				'resets it (`kex_exchange_identification: read: Connection reset by peer`). This is ' +
				"Daytona's egress filter, not the remote host refusing you - retrying, changing keys " +
				'or changing ports will not help.',
			'So do not plan to `ssh` into a remote server from here, and do not use an ssh:// or ' +
				'`git@host:` git remote. Reach for the HTTPS equivalent: a provider REST API, an MCP ' +
				'connector, or an https:// git remote.',
			'HTTPS works, to common developer hosts (GitHub, package registries and similar). A host ' +
				'outside that set is refused mid-connection, which looks like `curl: (35) Recv failure: ' +
				'Connection reset by peer` - report it rather than working around it.',
			'Other non-TLS protocols on any port behave like SSH: the connection is admitted and then ' +
				'reset once the traffic turns out not to be TLS.',
		],
	},
};

/**
 * The prompt block. Appended to every agent prompt on every run, so it reaches
 * runtime-created agents too - the same reach as `SHARED_INSTRUCTIONS`, which is
 * why it is composed beside it rather than written into any role's own prose.
 */
export function buildContainerEnvironmentBlock(backend: SandboxBackend): string {
	const env = SANDBOX_AGENT_ENVIRONMENTS[backend];
	// A backend this build does not know about (a downgrade, a stale bundle) is
	// better described as nothing than as the wrong provider's constraints.
	if (!env) return '';
	const kind =
		SANDBOX_BACKEND_KIND[backend] === 'remote' ? 'a third-party service' : 'this machine';
	return `

---

## Your Container Environment

You are running inside a container on **${env.label}** (${kind}). ${env.location}

This decides what you can reach from the shell, and it is not something you can
change from in here:

${env.egress.map((line) => `- ${line}`).join('\n')}
`;
}

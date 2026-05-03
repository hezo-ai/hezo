import { createPrivateKey } from 'node:crypto';
import { CredentialKind } from '@hezo/shared';

export type ValidationResult = { valid: true } | { valid: false; error: string };

export function validateCredentialValue(kind: string, value: string): ValidationResult {
	if (typeof value !== 'string' || value.length === 0) {
		return { valid: false, error: 'value is required' };
	}
	if (value.length > 64 * 1024) {
		return { valid: false, error: 'value exceeds 64KB limit' };
	}

	switch (kind) {
		case CredentialKind.SshPrivateKey:
			return validateSshPrivateKey(value);
		case CredentialKind.GithubPat:
			return validateGithubPat(value);
		case CredentialKind.ApiKey:
		case CredentialKind.OauthToken:
		case CredentialKind.WebhookSecret:
		case CredentialKind.Other:
			return { valid: true };
		default:
			return { valid: false, error: `unknown credential kind: ${kind}` };
	}
}

function validateSshPrivateKey(value: string): ValidationResult {
	const trimmed = value.trim();
	const isPem = /^-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/.test(trimmed);
	const isOpenssh = trimmed.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----');
	if (!isPem && !isOpenssh) {
		return {
			valid: false,
			error: 'value does not look like a PEM or OpenSSH private key',
		};
	}
	if (isPem) {
		try {
			createPrivateKey({ key: trimmed, format: 'pem' });
			return { valid: true };
		} catch (e) {
			return {
				valid: false,
				error: `failed to parse private key: ${(e as Error).message}`,
			};
		}
	}
	return { valid: true };
}

function validateGithubPat(value: string): ValidationResult {
	const trimmed = value.trim();
	const looksLikeClassicPat = /^ghp_[A-Za-z0-9]{20,}$/.test(trimmed);
	const looksLikeFineGrainedPat = /^github_pat_[A-Za-z0-9_]{20,}$/.test(trimmed);
	const looksLikeOauthToken = /^gho_[A-Za-z0-9]{20,}$/.test(trimmed);
	if (!looksLikeClassicPat && !looksLikeFineGrainedPat && !looksLikeOauthToken) {
		return {
			valid: false,
			error: 'value does not look like a GitHub PAT (expected ghp_, github_pat_, or gho_ prefix)',
		};
	}
	return { valid: true };
}

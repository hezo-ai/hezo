import { logger } from '../logger';
import type { DomainEvent, DomainEventHandler } from './types';

const log = logger.child('events');

/**
 * Minimal synchronous Subject for the Observer pattern. Business code emits
 * domain events without knowing who consumes them; observers (e.g. the audit
 * observer) subscribe once at startup.
 *
 * One instance lives per app (created in `startup.ts`, threaded like
 * `wsManager`) — never a module-level singleton, so tests that boot a fresh app
 * per `createTestContext` stay isolated.
 *
 * `emit` is fire-and-forget from the caller's perspective: each subscriber is
 * invoked in its own try/catch so one failing observer never breaks the request
 * path or another observer. Observers that do async work own their own
 * background tracking.
 */
export class DomainEventBus {
	private readonly handlers: DomainEventHandler[] = [];

	subscribe(handler: DomainEventHandler): void {
		this.handlers.push(handler);
	}

	emit(event: DomainEvent): void {
		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch (err) {
				log.error(`Observer threw handling ${event.type}:`, err);
			}
		}
	}
}

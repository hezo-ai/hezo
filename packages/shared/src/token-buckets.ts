/**
 * A run's tokens split by kind, as the runtimes report them.
 *
 * `inputTokens` here is the *uncached* remainder: cache reads and cache writes
 * are their own buckets and are never folded into it. That is the opposite of
 * the run row's `input_tokens`, which is the total input with both cache buckets
 * included - the figure a budget counts.
 */
export interface TokenBuckets {
	inputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	outputTokens: number;
}

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	RAM_CAP_PER_CONTAINER_GB_MAX,
	RAM_CAP_PER_CONTAINER_GB_MIN,
	roundRamCapGb,
} from '../src/constants';

describe('roundRamCapGb', () => {
	it('keeps values already at one decimal place', () => {
		expect(roundRamCapGb(0.5)).toBe(0.5);
		expect(roundRamCapGb(1)).toBe(1);
		expect(roundRamCapGb(2.5)).toBe(2.5);
		expect(roundRamCapGb(512)).toBe(512);
	});

	it('rounds to one decimal place', () => {
		expect(roundRamCapGb(0.55)).toBe(0.6);
		expect(roundRamCapGb(0.54)).toBe(0.5);
		expect(roundRamCapGb(1.249)).toBe(1.2);
		expect(roundRamCapGb(3.999)).toBe(4);
	});

	it('does not reintroduce float noise', () => {
		// 0.7 * 1024 ** 3 is the value that has to reach Docker as an integer;
		// the rounding step must not be what puts a tail back on it.
		expect(roundRamCapGb(0.7000000000000001)).toBe(0.7);
		expect(String(roundRamCapGb(2.3))).toBe('2.3');
	});

	it('falls back to the default for non-finite input', () => {
		expect(roundRamCapGb(Number.NaN)).toBe(DEFAULT_RAM_CAP_PER_CONTAINER_GB);
		expect(roundRamCapGb(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RAM_CAP_PER_CONTAINER_GB);
	});

	it('rounds without clamping - range enforcement is the caller/clamp helper job', () => {
		expect(roundRamCapGb(-4.06)).toBe(-4.1);
		expect(roundRamCapGb(9999.04)).toBe(9999);
	});

	it('the shipped bounds are themselves representable at one decimal place', () => {
		expect(roundRamCapGb(RAM_CAP_PER_CONTAINER_GB_MIN)).toBe(RAM_CAP_PER_CONTAINER_GB_MIN);
		expect(roundRamCapGb(RAM_CAP_PER_CONTAINER_GB_MAX)).toBe(RAM_CAP_PER_CONTAINER_GB_MAX);
		expect(roundRamCapGb(DEFAULT_RAM_CAP_PER_CONTAINER_GB)).toBe(DEFAULT_RAM_CAP_PER_CONTAINER_GB);
	});
});

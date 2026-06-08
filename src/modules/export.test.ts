import { describe, it, expect } from 'vitest';
import { formatBytes } from './export.js';

describe('formatBytes', () => {
  it('returns "—" for non-positive or non-finite inputs', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(Infinity)).toBe('—');
  });

  it('renders raw bytes with no decimals under 1 KiB', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('rolls up to KB/MB/GB at 1024-multiples', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
  });

  it('coarsens precision as the displayed value grows', () => {
    // < 10 → 2 decimals; 10–99 → 1 decimal; ≥ 100 → 0 decimals.
    expect(formatBytes(1024 * 1.5)).toBe('1.50 KB');
    expect(formatBytes(1024 * 15)).toBe('15.0 KB');
    expect(formatBytes(1024 * 150)).toBe('150 KB');
  });

  it('caps at TB rather than overflowing the unit table', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });
});

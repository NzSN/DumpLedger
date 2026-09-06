/**
 * Pure presentation helper tests (shared/format.ts). Byte sizes are decoded
 * by the contracts to bigint and must never lose precision on the way to
 * display; timestamps are canonical UTC ISO strings.
 */

import { describe, expect, it } from "vitest";
import { formatBytes, formatUtcDate, formatUtcTimestamp } from "../shared/format";

describe("formatBytes", () => {
  it("renders nullish sizes as Unknown", () => {
    expect(formatBytes(null)).toBe("Unknown");
    expect(formatBytes(undefined)).toBe("Unknown");
  });

  it("rejects negative sizes", () => {
    expect(formatBytes(-1n)).toBe("Unknown");
  });

  it("uses binary units without losing precision on huge bigint values", () => {
    expect(formatBytes(0n)).toBe("0 B");
    expect(formatBytes(1023n)).toBe("1023 B");
    expect(formatBytes(1024n)).toBe("1 KiB");
    expect(formatBytes(1536n)).toBe("1.5 KiB");
    expect(formatBytes(5n * 1024n ** 3n + 512n * 1024n ** 2n)).toBe("5.5 GiB");
  });

  it("handles values beyond the largest unit without truncation", () => {
    const huge = 12345678901234567890n;
    expect(formatBytes(huge)).not.toBe("Unknown");
    expect(formatBytes(huge)).toMatch(/PiB$/);
  });
});

describe("formatUtcTimestamp", () => {
  it("renders a canonical UTC ISO timestamp in YYYY-MM-DD HH:MM:SS UTC", () => {
    expect(formatUtcTimestamp("2026-09-06T08:15:30.000Z")).toBe("2026-09-06 08:15:30 UTC");
  });

  it("echoes invalid input rather than throwing", () => {
    expect(formatUtcTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
  });
});

describe("formatUtcDate", () => {
  it("renders the UTC date component", () => {
    expect(formatUtcDate("2026-09-06T23:59:59.000Z")).toBe("2026-09-06");
  });
});

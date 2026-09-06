/**
 * Byte and timestamp formatting for shared presentation (design section 8.4).
 *
 * Byte sizes cross the HTTP seam as canonical decimal strings and are decoded
 * by the contracts to `bigint`; this module never routes them through a
 * JavaScript `number`, so large dump sizes cannot lose precision.
 */

/** Binary units matching the legacy evidence-vault language. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export function formatBytes(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "Unknown";
  if (value < 0n) return "Unknown";
  let unitIndex = 0;
  let scale = 1n;
  while (unitIndex < BYTE_UNITS.length - 1 && value >= scale * 1024n) {
    scale *= 1024n;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${value.toString()} B`;
  const whole = value / scale;
  const decimal = ((value % scale) * 10n) / scale;
  const unit = BYTE_UNITS[unitIndex] as string;
  return decimal === 0n ? `${whole.toString()} ${unit}` : `${whole.toString()}.${decimal.toString()} ${unit}`;
}

/**
 * Formats a canonical UTC ISO timestamp (already runtime-validated) as
 * `YYYY-MM-DD HH:MM:SS UTC`. Invalid input is echoed back rather than thrown,
 * keeping presentation resilient against a changed backend.
 */
export function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 19)} UTC`;
}

export function formatUtcDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

import type { Duration } from "./types";

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/;

/** Parse a duration such as `"5m"` into milliseconds. */
export function toMs(value: Duration | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const match = PATTERN.exec(value);
  if (!match) {
    throw new TypeError(
      `Invalid duration "${value}": use a number followed by s, m, h or d`
    );
  }
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}

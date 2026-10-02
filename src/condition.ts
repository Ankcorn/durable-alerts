import type { Comparison, Condition, Row } from "./types";

function toNumber(value: unknown): number {
  // ClickHouse returns 64-bit integers (such as count()) as strings in JSON.
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return Number.NaN;
}

function compare(value: number, comparison: Comparison): boolean {
  if ("above" in comparison) return value > comparison.above;
  if ("atLeast" in comparison) return value >= comparison.atLeast;
  if ("below" in comparison) return value < comparison.below;
  if ("atMost" in comparison) return value <= comparison.atMost;
  throw new TypeError(`Unknown comparison ${JSON.stringify(comparison)}`);
}

/** Whether a row satisfies a condition. Non-numeric values never match. */
export function test<R extends Row>(condition: Condition<R>, row: R): boolean {
  if (typeof condition === "function") return Boolean(condition(row));
  const entries = Object.entries(condition) as Array<[string, Comparison]>;
  if (entries.length === 0) return false;
  return entries.every(([column, comparison]) => {
    const value = toNumber(row[column]);
    return !Number.isNaN(value) && compare(value, comparison);
  });
}

import { test } from "./condition";
import { toMs } from "./duration";
import type { AlertDefinition, AlertSpec, Row } from "./types";

const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_WINDOW_MS = 31 * 86_400_000;

/** Throw a descriptive error if a spec cannot work. */
export function validateSpec(spec: AlertSpec<Row, string>): void {
  const fail = (message: string): never => {
    throw new TypeError(`Alert "${spec.name}": ${message}`);
  };
  if (typeof spec.name !== "string" || !NAME.test(spec.name)) {
    fail("name must be 1-128 letters, digits, or . _ : -");
  }
  if (!spec.query || typeof spec.query.text !== "string") {
    fail("query must be built with the sql`` tag");
  }
  if (
    !spec.query.text.includes("$start") ||
    !spec.query.text.includes("$end")
  ) {
    fail("query must filter on the window, for example WHERE ${sql.window}");
  }
  const every = toMs(spec.every);
  if (every < 10_000) fail("every must be at least 10s");
  const window = toMs(spec.window, every);
  if (window <= 0 || window > MAX_WINDOW_MS) {
    fail("window must be positive and at most 31d");
  }
  toMs(spec.delay);
  toMs(spec.fireAfter);
  toMs(spec.resolveAfter);
  if (spec.fireWhen === undefined) fail("fireWhen is required");
}

/** The key for a row: the `groupBy` result, or `""` for ungrouped alerts. */
export function keyOf<R extends Row, K extends string>(
  spec: AlertSpec<R, K>,
  row: R
): K {
  if (!spec.groupBy) return "" as K;
  return String(spec.groupBy(row)) as K;
}

/** Rows by key. Ungrouped alerts use only the first row; first row wins. */
export function groupRows<R extends Row, K extends string>(
  spec: AlertSpec<R, K>,
  rows: readonly R[]
): Map<K, R> {
  const grouped = new Map<K, R>();
  for (const row of spec.groupBy ? rows : rows.slice(0, 1)) {
    const key = keyOf(spec, row);
    if (!grouped.has(key)) grouped.set(key, row);
  }
  return grouped;
}

export function isBreach<R extends Row, K extends string>(
  spec: AlertSpec<R, K>,
  row: R
): boolean {
  return test(spec.fireWhen, row);
}

export function isClear<R extends Row, K extends string>(
  spec: AlertSpec<R, K>,
  row: R
): boolean {
  return spec.resolveWhen
    ? test(spec.resolveWhen, row)
    : !test(spec.fireWhen, row);
}

/**
 * Declare an alert on its own, so it can be shared, imported, and unit
 * tested. Pass it to `alerts(...).watch(definition, handlers)`.
 */
export function defineAlert<R extends Row, K extends string = string>(
  spec: AlertSpec<R, K>
): AlertDefinition<R, K> {
  validateSpec(spec as unknown as AlertSpec<Row, string>);
  return {
    ...spec,
    evaluate(rows, open = []) {
      const grouped = groupRows(spec, rows);
      const openKeys = new Set(open);
      const fire: K[] = [];
      for (const [key, row] of grouped) {
        if (!openKeys.has(key) && isBreach(spec, row)) fire.push(key);
      }
      const resolve = open.filter((key) => {
        const row = grouped.get(key);
        if (row === undefined)
          return (spec.onNoData ?? "resolve") === "resolve";
        return isClear(spec, row);
      });
      return { fire, resolve };
    }
  };
}

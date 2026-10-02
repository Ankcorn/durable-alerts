import type { Query, Row, SqlFragment, SqlParameter } from "./types";

function fragment(text: string): SqlFragment {
  return { __fragment: text };
}

function isFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SqlFragment).__fragment === "string"
  );
}

function template<R extends Row>(
  strings: TemplateStringsArray,
  ...values: Array<SqlFragment | SqlParameter>
): Query<R> {
  let text = strings[0] ?? "";
  const params: Record<string, SqlParameter> = {};
  values.forEach((value, index) => {
    if (isFragment(value)) {
      text += value.__fragment;
    } else {
      const name = `p${index}`;
      params[name] = value;
      text += `$${name}`;
    }
    text += strings[index + 1] ?? "";
  });
  return { text, params };
}

export interface SqlTag {
  /**
   * Build a typed query. Interpolated values become named parameters.
   *
   * ```ts
   * sql<{ errors: number }>`SELECT count() AS errors FROM logs.workersLogs
   *   WHERE ${sql.window} AND scriptName = ${name}`
   * ```
   */
  <R extends Row>(
    strings: TemplateStringsArray,
    ...values: Array<SqlFragment | SqlParameter>
  ): Query<R>;
  /** `timestamp >= $start AND timestamp < $end` for the evaluation window. */
  readonly window: SqlFragment;
  /** The evaluation window on a column other than `timestamp`. */
  windowOn(column: string): SqlFragment;
  /** Insert SQL verbatim. Never pass user input. */
  raw(text: string): SqlFragment;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export const sql: SqlTag = Object.assign(template, {
  window: fragment("timestamp >= $start AND timestamp < $end"),
  windowOn(column: string): SqlFragment {
    if (!IDENTIFIER.test(column)) {
      throw new TypeError(`Invalid column name "${column}"`);
    }
    return fragment(`${column} >= $start AND ${column} < $end`);
  },
  raw: fragment
});

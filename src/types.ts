/** A duration such as `"30s"`, `"5m"`, `"1h"` or `"7d"`. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

/** A JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** What `onFire` may return: any JSON value, or nothing. */
export type Json = JsonValue | void;

/** A column value in a query result. */
export type Value =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | null)[];

/**
 * One row returned by an alert query. Values are plain JSON scalars (or
 * arrays of them), so incidents can be stored and returned over RPC.
 */
export type Row = { readonly [column: string]: Value };

/** A parameter value accepted by Analytics SQL. */
export type SqlParameter = string | number | boolean | null;

/**
 * The subset of the Workers Analytics SQL binding that alerts use. The
 * `analytics` binding from `wrangler.jsonc` satisfies it, and so does any
 * fake you pass in tests.
 */
export interface AnalyticsSql {
  query<T extends Record<string, unknown>>(request: {
    query: string;
    params?: Readonly<Record<string, SqlParameter>>;
  }): Promise<{ data: T[] }>;
}

/** A typed Analytics SQL query. `R` is the shape of one returned row. */
export interface Query<R extends Row> {
  readonly text: string;
  readonly params: Readonly<Record<string, SqlParameter>>;
  /** Phantom field carrying the row type. Never set at runtime. */
  readonly __row?: R;
}

/** A piece of SQL that is inserted verbatim rather than as a parameter. */
export interface SqlFragment {
  readonly __fragment: string;
}

type NumericKeys<R> = {
  [K in keyof R]-?: R[K] extends number ? K : never;
}[keyof R];

/** A comparison against one numeric column. */
export type Comparison =
  | { readonly above: number }
  | { readonly atLeast: number }
  | { readonly below: number }
  | { readonly atMost: number };

/**
 * Either a predicate, or comparisons on numeric columns (all must hold):
 *
 * ```ts
 * fireWhen: { errors: { above: 50 } }
 * fireWhen: (row) => row.errors / row.requests > 0.05
 * ```
 */
export type Condition<R extends Row> =
  | ((row: R) => boolean)
  | { readonly [K in NumericKeys<R>]?: Comparison };

/** What to watch and when it counts as an incident. */
export interface AlertSpec<R extends Row, K extends string = string> {
  /** Unique within the Durable Object. Re-declaring a name updates the alert. */
  readonly name: string;
  readonly query: Query<R>;

  /** How often to run the query. */
  readonly every: Duration;
  /** How far back `sql.window` looks. Defaults to `every`. */
  readonly window?: Duration;
  /** Shift the window back to allow for ingestion lag. Defaults to `"0s"`. */
  readonly delay?: Duration;

  /**
   * Open one incident per key, for example per script. A single query can
   * then have many incidents open at once. Omit it for a single incident,
   * in which case only the first row is used.
   */
  readonly groupBy?: (row: R) => K;

  /** When an incident fires. */
  readonly fireWhen: Condition<R>;
  /**
   * When a firing incident resolves. Defaults to "`fireWhen` no longer
   * holds". Set it to a lower threshold to stop the alert flapping.
   */
  readonly resolveWhen?: Condition<R>;

  /** The breach must last this long before firing. Defaults to `"0s"`. */
  readonly fireAfter?: Duration;
  /** The recovery must last this long before resolving. Defaults to `"0s"`. */
  readonly resolveAfter?: Duration;

  /**
   * What it means when the query returns no row for an open incident's key.
   * `"resolve"` (the default) treats it as recovered, which is right for
   * queries such as `WHERE status >= 500 GROUP BY scriptName` where a
   * healthy script returns no row. `"keep"` leaves the incident as it is.
   */
  readonly onNoData?: "resolve" | "keep";

  /** The incident title. Defaults to the name, plus the key when grouped. */
  readonly title?: (row: R, key: K) => string;
}

/** An alert declared on its own, outside any Durable Object. */
export interface AlertDefinition<
  R extends Row,
  K extends string = string
> extends AlertSpec<R, K> {
  /**
   * Pure evaluation for unit tests. Ignores `fireAfter` and `resolveAfter`.
   * Returns which keys would fire, and which of the `open` keys would resolve.
   */
  evaluate(
    rows: readonly R[],
    open?: readonly K[]
  ): { fire: K[]; resolve: K[] };
}

/** One breach of an alert. */
export interface Incident<R extends Row = Row, K extends string = string> {
  /** Stable for the life of the incident. Use it as an idempotency key. */
  readonly id: string;
  readonly alert: string;
  /** The `groupBy` key, or `""` for an ungrouped alert. */
  readonly key: K;
  readonly title: string;
  readonly firedAt: Date;
  /** The row that crossed the threshold. */
  readonly row: R;
}

export type ResolveReason = "recovered" | "no-data" | "manual";

/** An incident that has resolved. */
export interface ResolvedIncident<
  R extends Row = Row,
  K extends string = string,
  F = unknown
> extends Incident<R, K> {
  readonly resolvedAt: Date;
  readonly durationMs: number;
  readonly reason: ResolveReason;
  /** The most recent row for this key, if the query still returned one. */
  readonly lastRow: R | undefined;
  /** Whatever `onFire` returned. */
  readonly fired: F;
}

/**
 * Callbacks are attempted once. Users own retries and delivery guarantees.
 * A restart during a callback does not cause it to be delivered again.
 */
export interface IncidentHandlers<
  R extends Row,
  K extends string,
  F extends Json
> {
  /** Runs once when the incident opens. The return value is persisted. */
  onFire(incident: Incident<R, K>): F | Promise<F>;
  /** Runs once when it resolves, with `incident.fired` set to `onFire`'s result. */
  onResolve?(incident: ResolvedIncident<R, K, F>): void | Promise<void>;
}

/** The incident type for a definition: `IncidentOf<typeof errorRate>`. */
export type IncidentOf<D> =
  D extends AlertSpec<infer R, infer K> ? Incident<R, K> : never;

/** The resolved incident type for a definition. */
export type ResolvedIncidentOf<D, F = unknown> =
  D extends AlertSpec<infer R, infer K> ? ResolvedIncident<R, K, F> : never;

export type IncidentStatus = "firing" | "resolving" | "resolved";

/** An incident as stored, for dashboards and tools. */
export interface IncidentRecord {
  readonly id: string;
  readonly alert: string;
  readonly key: string;
  readonly title: string;
  readonly status: IncidentStatus;
  readonly firedAt: Date;
  readonly resolvedAt: Date | undefined;
  readonly reason: ResolveReason | "alert-removed" | undefined;
  readonly row: Row;
  readonly lastRow: Row | undefined;
  /** Set when a handler failed or its attempt did not complete. */
  readonly deliveryError: string | undefined;
}

export interface AlertStatus {
  readonly name: string;
  readonly every: Duration;
  readonly nextCheckAt: Date;
  readonly lastCheckedAt: Date | undefined;
  readonly lastError: string | undefined;
  readonly pausedUntil: Date | undefined;
  /** Open incidents (firing or resolving). */
  readonly open: number;
}

export interface CheckResult {
  /** Ids of incidents that fired during this check. */
  readonly fired: string[];
  /** Ids of incidents that resolved during this check. */
  readonly resolved: string[];
}

export interface AlertError {
  readonly alert: string;
  readonly phase: "query" | "onFire" | "onResolve";
  readonly incidentId: string | undefined;
  readonly error: unknown;
}

export interface AlertsOptions {
  /** The Analytics SQL binding, for example `this.env.ANALYTICS_SQL`. */
  readonly sql: AnalyticsSql;
  /** How long to keep resolved incidents. Defaults to `"7d"`. */
  readonly retention?: Duration;
  /** Called when a query or handler fails. Defaults to `console.error`. */
  readonly onError?: (error: AlertError) => void;
  /** Override the clock. Intended for tests. */
  readonly now?: () => number;
}

/** The alerts attached to one Durable Object. */
export interface Alerts {
  /**
   * Declare an alert. Idempotent by name, so declare alerts in a field
   * initializer or the constructor: the code is the source of truth and a
   * deploy updates alerts in place. Alerts that are no longer declared are
   * removed on the next wake, and their open incidents are closed without
   * calling a handler.
   */
  watch<R extends Row, K extends string, F extends Json>(
    spec: AlertSpec<R, K> & IncidentHandlers<R, K, F>
  ): this;
  watch<R extends Row, K extends string, F extends Json>(
    definition: AlertSpec<R, K>,
    handlers: IncidentHandlers<R, K, F>
  ): this;

  /** Resolves once declared alerts are stored and the next check is scheduled. */
  readonly ready: Promise<void>;

  /** Call this from the Durable Object's `alarm()` handler. */
  alarm(info?: AlarmInvocationInfo): Promise<void>;

  /** Every declared alert and when it next runs. */
  status(): Promise<AlertStatus[]>;
  /** Stored incidents, newest first. */
  incidents(filter?: {
    readonly status?: IncidentStatus | "open";
    readonly alert?: string;
    readonly limit?: number;
  }): Promise<IncidentRecord[]>;
  /** Run one alert now, outside its schedule. */
  check(name: string): Promise<CheckResult>;
  /** Resolve an incident by hand. Calls `onResolve` with reason `"manual"`. */
  resolve(incidentId: string): Promise<void>;
  /** Stop checking an alert, for a while or until `resume`. */
  pause(name: string, duration?: Duration): Promise<void>;
  resume(name: string): Promise<void>;
}

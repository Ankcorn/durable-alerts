import { groupRows, isBreach, isClear, validateSpec } from "./define";
import { toMs } from "./duration";
import type {
  AlertError,
  Alerts,
  AlertSpec,
  AlertsOptions,
  AlertStatus,
  CheckResult,
  Duration,
  Incident,
  IncidentHandlers,
  IncidentRecord,
  IncidentStatus,
  Json,
  ResolvedIncident,
  ResolveReason,
  Row,
  SqlParameter
} from "./types";

type AnySpec = AlertSpec<Row, string>;
type AnyHandlers = IncidentHandlers<Row, string, Json>;
type Entry = { spec: AnySpec; handlers: AnyHandlers };

type DeliveryState = "pending" | "done" | "failed" | "skipped";

type QueryRun = {
  query: string;
  params: Record<string, SqlParameter>;
  checkedAt: number;
  nextRunAt?: number;
  attempts: number;
};

type AlertRow = {
  name: string;
  every: string;
  next_run_at: number;
  last_checked_at: number | null;
  last_error: string | null;
  failed: number;
  query_run: string | null;
  retry_at: number | null;
  paused_until: number | null;
};

type IncidentRow = {
  id: string;
  alert: string;
  key: string;
  title: string;
  status: IncidentStatus;
  fired_at: number;
  clear_since: number | null;
  resolved_at: number | null;
  reason: string | null;
  row: string;
  last_row: string | null;
  fired: string | null;
  fire_delivery: DeliveryState;
  resolve_delivery: DeliveryState | null;
  delivery_error: string | null;
};

const ALERTS = "_durable_alerts";
const INCIDENTS = "_durable_alerts_incidents";
const PENDING = "_durable_alerts_pending";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ALERTS} (
    name TEXT PRIMARY KEY,
    every TEXT NOT NULL,
    next_run_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_error TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    query_run TEXT,
    retry_at INTEGER,
    paused_until INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS ${INCIDENTS} (
    id TEXT PRIMARY KEY,
    alert TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    clear_since INTEGER,
    resolved_at INTEGER,
    reason TEXT,
    row TEXT NOT NULL,
    last_row TEXT,
    fired TEXT,
    fire_delivery TEXT NOT NULL,
    resolve_delivery TEXT,
    delivery_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${INCIDENTS}_by_alert
    ON ${INCIDENTS} (alert, status)`,
  `CREATE TABLE IF NOT EXISTS ${PENDING} (
    alert TEXT NOT NULL,
    key TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (alert, key)
  )`
];

/** `paused_until` value meaning "until resumed". */
const FOREVER = 8_640_000_000_000_000;
const DEFAULT_LIMIT = 100;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parse<T>(json: string | null): T | undefined {
  return json === null ? undefined : (JSON.parse(json) as T);
}

class AlertsRuntime implements Alerts {
  readonly ready: Promise<void>;

  readonly #ctx: DurableObjectState;
  readonly #sql: SqlStorage;
  readonly #options: AlertsOptions;
  readonly #entries = new Map<string, Entry>();
  #reconciled = false;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, options: AlertsOptions) {
    this.#ctx = ctx;
    this.#options = options;
    try {
      this.#sql = ctx.storage.sql;
      for (const statement of SCHEMA) this.#sql.exec(statement);
    } catch (cause) {
      throw new Error(
        "durable-alerts needs a SQLite-backed Durable Object: declare the class under `new_sqlite_classes` in your migrations",
        { cause }
      );
    }
    // Wait one microtask so every chained `.watch()` from the field
    // initializer or constructor is registered before reconciling.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await Promise.resolve();
      this.#reconcile();
      await this.#schedule();
    });
    this.ready.catch(() => {});
  }

  watch<R extends Row, K extends string, F extends Json>(
    spec: AlertSpec<R, K> & IncidentHandlers<R, K, F>
  ): this;
  watch<R extends Row, K extends string, F extends Json>(
    definition: AlertSpec<R, K>,
    handlers: IncidentHandlers<R, K, F>
  ): this;
  watch(spec: AnySpec, handlers?: AnyHandlers): this {
    const resolvedHandlers = handlers ?? (spec as AnySpec & AnyHandlers);
    validateSpec(spec);
    if (typeof resolvedHandlers.onFire !== "function") {
      throw new TypeError(`Alert "${spec.name}": onFire is required`);
    }
    if (this.#entries.has(spec.name)) {
      throw new Error(`Alert "${spec.name}" is declared twice`);
    }
    this.#entries.set(spec.name, { spec, handlers: resolvedHandlers });
    if (this.#reconciled) {
      this.#upsert(spec, this.#now());
      this.#schedule().catch((error: unknown) =>
        this.#report({ alert: spec.name, phase: "query", error })
      );
    }
    return this;
  }

  async alarm(_info?: AlarmInvocationInfo): Promise<void> {
    await this.ready;
    await this.#exclusive(async () => {
      try {
        const now = this.#now();
        const due = this.#sql
          .exec<Pick<AlertRow, "name" | "next_run_at">>(
            `SELECT name, next_run_at FROM ${ALERTS}
             WHERE failed = 0 AND coalesce(retry_at, next_run_at) <= ?
               AND (paused_until IS NULL OR paused_until <= ?)`,
            now,
            now
          )
          .toArray();
        for (const { name, next_run_at } of due) {
          await this.#evaluate(name, next_run_at);
        }
        await this.#deliver();
        this.#prune();
      } finally {
        await this.#schedule();
      }
    });
  }

  async status(): Promise<AlertStatus[]> {
    await this.ready;
    return this.#sql
      .exec<AlertRow & { open: number }>(
        `SELECT a.*, (
           SELECT count(*) FROM ${INCIDENTS} i
           WHERE i.alert = a.name AND i.status != 'resolved'
         ) AS open
         FROM ${ALERTS} a ORDER BY a.name`
      )
      .toArray()
      .map((row) => ({
        name: row.name,
        every: row.every as Duration,
        failed: row.failed !== 0,
        retrying: row.query_run !== null,
        nextCheckAt:
          row.failed !== 0
            ? undefined
            : new Date(
                Math.max(row.retry_at ?? row.next_run_at, row.paused_until ?? 0)
              ),
        lastCheckedAt:
          row.last_checked_at === null
            ? undefined
            : new Date(row.last_checked_at),
        lastError: row.last_error ?? undefined,
        pausedUntil:
          row.paused_until === null ? undefined : new Date(row.paused_until),
        open: row.open
      }));
  }

  async incidents(
    filter: {
      status?: IncidentStatus | "open";
      alert?: string;
      limit?: number;
    } = {}
  ): Promise<IncidentRecord[]> {
    await this.ready;
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (filter.status === "open") {
      where.push("status != 'resolved'");
    } else if (filter.status) {
      where.push("status = ?");
      bindings.push(filter.status);
    }
    if (filter.alert) {
      where.push("alert = ?");
      bindings.push(filter.alert);
    }
    bindings.push(filter.limit ?? DEFAULT_LIMIT);
    return this.#sql
      .exec<IncidentRow>(
        `SELECT * FROM ${INCIDENTS}
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY fired_at DESC LIMIT ?`,
        ...bindings
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        alert: row.alert,
        key: row.key,
        title: row.title,
        status: row.status,
        firedAt: new Date(row.fired_at),
        resolvedAt:
          row.resolved_at === null ? undefined : new Date(row.resolved_at),
        reason: (row.reason ?? undefined) as IncidentRecord["reason"],
        row: JSON.parse(row.row) as Row,
        lastRow: parse<Row>(row.last_row),
        deliveryError: row.delivery_error ?? undefined
      }));
  }

  async check(name: string): Promise<CheckResult> {
    await this.ready;
    this.#entry(name);
    return this.#exclusive(async () => {
      try {
        const result = await this.#evaluate(name);
        await this.#deliver();
        return result;
      } finally {
        await this.#schedule();
      }
    });
  }

  async resolve(incidentId: string): Promise<void> {
    await this.ready;
    await this.#exclusive(async () => {
      const incident = this.#incident(incidentId);
      if (!incident) throw new Error(`Unknown incident "${incidentId}"`);
      if (incident.status === "resolved") return;
      this.#ctx.storage.transactionSync(() =>
        this.#resolveIncident(incident, "manual", this.#now())
      );
      try {
        await this.#deliver();
      } finally {
        await this.#schedule();
      }
    });
  }

  async pause(name: string, duration?: Duration): Promise<void> {
    await this.ready;
    this.#entry(name);
    const until =
      duration === undefined ? FOREVER : this.#now() + toMs(duration);
    this.#sql.exec(
      `UPDATE ${ALERTS} SET paused_until = ? WHERE name = ?`,
      until,
      name
    );
    await this.#schedule();
  }

  async resume(name: string): Promise<void> {
    await this.ready;
    this.#entry(name);
    this.#sql.exec(
      `UPDATE ${ALERTS} SET paused_until = NULL, failed = 0, last_error = NULL,
         next_run_at = min(next_run_at, ?)
       WHERE name = ?`,
      this.#now(),
      name
    );
    await this.#schedule();
  }

  // ── Declaration ────────────────────────────────────────────────────────────

  #reconcile(): void {
    const now = this.#now();
    this.#ctx.storage.transactionSync(() => {
      for (const { spec } of this.#entries.values()) this.#upsert(spec, now);
      const stored = this.#sql
        .exec<{ name: string }>(`SELECT name FROM ${ALERTS}`)
        .toArray();
      for (const { name } of stored) {
        if (!this.#entries.has(name)) this.#remove(name, now);
      }
    });
    this.#reconciled = true;
  }

  #upsert(spec: AnySpec, now: number): void {
    const existing = this.#sql
      .exec<{ every: string }>(
        `SELECT every FROM ${ALERTS} WHERE name = ?`,
        spec.name
      )
      .toArray()[0];
    if (!existing) {
      this.#sql.exec(
        `INSERT INTO ${ALERTS} (name, every, next_run_at) VALUES (?, ?, ?)`,
        spec.name,
        spec.every,
        now
      );
    } else if (existing.every !== spec.every) {
      this.#sql.exec(
        `UPDATE ${ALERTS} SET every = ?, next_run_at = ? WHERE name = ?`,
        spec.every,
        now,
        spec.name
      );
    }
  }

  /** Forget an alert that is no longer declared. Its handlers are gone, so none run. */
  #remove(name: string, now: number): void {
    this.#sql.exec(`DELETE FROM ${ALERTS} WHERE name = ?`, name);
    this.#sql.exec(`DELETE FROM ${PENDING} WHERE alert = ?`, name);
    this.#sql.exec(
      `UPDATE ${INCIDENTS} SET
         status = 'resolved',
         resolved_at = coalesce(resolved_at, ?),
         reason = coalesce(reason, 'alert-removed'),
         fire_delivery = CASE WHEN fire_delivery = 'pending' THEN 'skipped' ELSE fire_delivery END,
         resolve_delivery = CASE WHEN resolve_delivery = 'done' THEN 'done' ELSE 'skipped' END
       WHERE alert = ? AND (status != 'resolved' OR fire_delivery = 'pending' OR resolve_delivery = 'pending')`,
      now,
      name
    );
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Run one alert's query and apply the result. With `scheduledAt` this is a
   * scheduled check: the window is anchored to the scheduled time and the
   * next run is booked. Without it, it is an extra check that leaves the
   * schedule alone.
   */
  async #evaluate(name: string, scheduledAt?: number): Promise<CheckResult> {
    const { spec } = this.#entry(name);
    const stored = this.#sql
      .exec<Pick<AlertRow, "failed" | "query_run" | "retry_at">>(
        `SELECT failed, query_run, retry_at FROM ${ALERTS} WHERE name = ?`,
        name
      )
      .one();
    if (stored.failed) {
      throw new Error(
        `Alert "${name}" has failed; call resume() before checking it again`
      );
    }
    const now = this.#now();
    // A pending run owns this alert until its original window succeeds.
    if (stored.retry_at !== null && stored.retry_at > now) {
      return { fired: [], resolved: [] };
    }
    let run = parse<QueryRun>(stored.query_run);
    if (!run) {
      const every = toMs(spec.every);
      const anchor = scheduledAt ?? now;
      const end = anchor - toMs(spec.delay);
      run = {
        query: spec.query.text,
        params: {
          ...spec.query.params,
          start: new Date(end - toMs(spec.window, every)).toISOString(),
          end: new Date(end).toISOString()
        },
        checkedAt: anchor,
        nextRunAt: scheduledAt === undefined ? undefined : anchor + every,
        attempts: 0
      };
    }
    run.attempts++;
    const retryDelay = Math.min(
      10_000 * 2 ** Math.min(run.attempts - 1, 5),
      300_000
    );
    // Save before issuing the query so an interrupted call retains its window.
    this.#sql.exec(
      `UPDATE ${ALERTS} SET query_run = ?, retry_at = ? WHERE name = ?`,
      JSON.stringify(run),
      now + retryDelay,
      name
    );
    await this.#ctx.storage.sync();

    let rows: Row[];
    try {
      if (typeof this.#options.sql?.query !== "function") {
        throw new TypeError(
          `AlertsOptions.sql is not an Analytics SQL binding (got ${typeof this.#options.sql}). Check the "analytics" binding in wrangler.jsonc.`
        );
      }
      const result = await this.#options.sql.query<Row>({
        query: run.query,
        params: run.params
      });
      rows = result.data;
    } catch (error) {
      const retryable =
        typeof error === "object" &&
        error !== null &&
        "retryable" in error &&
        error.retryable === true;
      this.#ctx.storage.transactionSync(() => {
        this.#recordCheck(
          name,
          now,
          retryable ? undefined : run.nextRunAt,
          message(error)
        );
        if (retryable) {
          this.#sql.exec(
            `UPDATE ${ALERTS} SET retry_at = ? WHERE name = ?`,
            this.#now() + retryDelay,
            name
          );
        } else this.#clearQuery(name);
      });
      this.#report({ alert: name, phase: "query", error });
      return { fired: [], resolved: [] };
    }

    try {
      return this.#ctx.storage.transactionSync(() => {
        this.#recordCheck(name, now, run.nextRunAt, null);
        const result = this.#apply(spec, rows, run.checkedAt);
        this.#clearQuery(name);
        return result;
      });
    } catch (error) {
      // Evaluation rolled back. Persist the failure outside that transaction
      // and disable this alert without interrupting the rest of the alarm.
      this.#sql.exec(
        `UPDATE ${ALERTS} SET failed = 1, last_checked_at = ?, last_error = ?,
           query_run = NULL, retry_at = NULL
         WHERE name = ?`,
        now,
        message(error),
        name
      );
      this.#report({ alert: name, phase: "evaluation", error });
      return { fired: [], resolved: [] };
    }
  }

  #clearQuery(name: string): void {
    this.#sql.exec(
      `UPDATE ${ALERTS} SET query_run = NULL, retry_at = NULL WHERE name = ?`,
      name
    );
  }

  #recordCheck(
    name: string,
    now: number,
    nextRunAt: number | undefined,
    error: string | null
  ): void {
    this.#sql.exec(
      `UPDATE ${ALERTS} SET last_checked_at = ?, last_error = ?,
         next_run_at = coalesce(?, next_run_at)
       WHERE name = ?`,
      now,
      error,
      nextRunAt ?? null,
      name
    );
  }

  #apply(spec: AnySpec, rows: Row[], now: number): CheckResult {
    const fired: string[] = [];
    const resolved: string[] = [];
    const fireAfter = toMs(spec.fireAfter);
    const grouped = groupRows(spec, rows);

    const open = new Map(
      this.#sql
        .exec<IncidentRow>(
          `SELECT * FROM ${INCIDENTS} WHERE alert = ? AND status != 'resolved'`,
          spec.name
        )
        .toArray()
        .map((incident) => [incident.key, incident])
    );
    const pending = new Map(
      this.#sql
        .exec<{ key: string; since: number }>(
          `SELECT key, since FROM ${PENDING} WHERE alert = ?`,
          spec.name
        )
        .toArray()
        .map(({ key, since }) => [key, since])
    );

    for (const [key, row] of grouped) {
      const incident = open.get(key);
      if (incident) {
        this.#sql.exec(
          `UPDATE ${INCIDENTS} SET last_row = ? WHERE id = ?`,
          JSON.stringify(row),
          incident.id
        );
        const outcome = this.#progress(
          spec,
          incident,
          isClear(spec, row),
          now,
          "recovered"
        );
        if (outcome) resolved.push(incident.id);
        continue;
      }

      const since = pending.get(key);
      pending.delete(key);
      if (!isBreach(spec, row)) {
        if (since !== undefined) this.#clearPending(spec.name, key);
        continue;
      }
      if (now - (since ?? now) >= fireAfter) {
        if (since !== undefined) this.#clearPending(spec.name, key);
        fired.push(this.#fire(spec, key, row, now));
      } else if (since === undefined) {
        this.#sql.exec(
          `INSERT INTO ${PENDING} (alert, key, since) VALUES (?, ?, ?)`,
          spec.name,
          key,
          now
        );
      }
    }

    // Keys that were breaching but have no row this time are no longer pending.
    for (const key of pending.keys()) this.#clearPending(spec.name, key);

    // Open incidents whose key returned no row.
    if ((spec.onNoData ?? "resolve") === "resolve") {
      for (const [key, incident] of open) {
        if (grouped.has(key)) continue;
        if (this.#progress(spec, incident, true, now, "no-data")) {
          resolved.push(incident.id);
        }
      }
    }

    return { fired, resolved };
  }

  /** Move an open incident towards resolved. Returns true if it resolved. */
  #progress(
    spec: AnySpec,
    incident: IncidentRow,
    clear: boolean,
    now: number,
    reason: ResolveReason
  ): boolean {
    if (!clear) {
      if (incident.status === "resolving") {
        this.#sql.exec(
          `UPDATE ${INCIDENTS} SET status = 'firing', clear_since = NULL WHERE id = ?`,
          incident.id
        );
      }
      return false;
    }
    const clearSince = incident.clear_since ?? now;
    if (now - clearSince >= toMs(spec.resolveAfter)) {
      this.#resolveIncident(incident, reason, now);
      return true;
    }
    if (incident.status === "firing") {
      this.#sql.exec(
        `UPDATE ${INCIDENTS} SET status = 'resolving', clear_since = ? WHERE id = ?`,
        now,
        incident.id
      );
    }
    return false;
  }

  #fire(spec: AnySpec, key: string, row: Row, now: number): string {
    const id = crypto.randomUUID();
    const json = JSON.stringify(row);
    this.#sql.exec(
      `INSERT INTO ${INCIDENTS}
         (id, alert, key, title, status, fired_at, row, last_row,
          fire_delivery)
       VALUES (?, ?, ?, ?, 'firing', ?, ?, ?, 'pending')`,
      id,
      spec.name,
      key,
      this.#title(spec, row, key),
      now,
      json,
      json
    );
    return id;
  }

  #resolveIncident(
    incident: IncidentRow,
    reason: ResolveReason,
    now: number
  ): void {
    const current = this.#incident(incident.id) ?? incident;
    const handlers = this.#entries.get(current.alert)?.handlers;
    const fireFailed =
      current.fire_delivery === "failed" || current.fire_delivery === "skipped";
    const resolveDelivery: DeliveryState =
      handlers?.onResolve && !fireFailed ? "pending" : "skipped";
    this.#sql.exec(
      `UPDATE ${INCIDENTS} SET
         status = 'resolved', resolved_at = ?, reason = ?, clear_since = NULL,
         resolve_delivery = ?
       WHERE id = ?`,
      now,
      reason,
      resolveDelivery,
      current.id
    );
  }

  #clearPending(alert: string, key: string): void {
    this.#sql.exec(
      `DELETE FROM ${PENDING} WHERE alert = ? AND key = ?`,
      alert,
      key
    );
  }

  #title(spec: AnySpec, row: Row, key: string): string {
    try {
      if (spec.title) return spec.title(row, key);
    } catch (error) {
      this.#report({ alert: spec.name, phase: "query", error });
    }
    return key ? `${spec.name}: ${key}` : spec.name;
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  async #deliver(): Promise<void> {
    const due = this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM ${INCIDENTS}
         WHERE fire_delivery = 'pending' OR resolve_delivery = 'pending'
         ORDER BY fired_at`
      )
      .toArray();
    for (const { id } of due) await this.#deliverIncident(id);
  }

  async #deliverIncident(id: string): Promise<void> {
    // At most two passes: onFire, then onResolve if it already resolved.
    for (let pass = 0; pass < 2; pass++) {
      const incident = this.#incident(id);
      if (!incident) return;

      const kind =
        incident.fire_delivery === "pending"
          ? "fire"
          : incident.resolve_delivery === "pending"
            ? "resolve"
            : undefined;
      if (!kind) return;

      const entry = this.#entries.get(incident.alert);
      if (!entry) {
        this.#sql.exec(
          `UPDATE ${INCIDENTS} SET ${kind}_delivery = 'skipped' WHERE id = ?`,
          id
        );
        return;
      }

      const { handlers } = entry;
      // Persist the attempt before invoking user code so a restart cannot
      // deliver the callback again.
      this.#sql.exec(
        `UPDATE ${INCIDENTS} SET ${kind}_delivery = 'failed',
           delivery_error = ?,
           resolve_delivery = CASE
             WHEN ? = 'fire' AND resolve_delivery = 'pending' THEN 'skipped'
             ELSE resolve_delivery END
         WHERE id = ?`,
        `${kind === "fire" ? "onFire" : "onResolve"} did not complete`,
        kind,
        id
      );
      await this.#ctx.storage.sync();

      try {
        if (kind === "fire") {
          const result = await handlers.onFire(this.#toIncident(incident));
          const json = result === undefined ? null : JSON.stringify(result);
          this.#sql.exec(
            `UPDATE ${INCIDENTS} SET
               fire_delivery = 'done', fired = ?, delivery_error = NULL,
               resolve_delivery = ?
             WHERE id = ?`,
            json,
            incident.resolve_delivery,
            id
          );
          continue;
        }
        await handlers.onResolve?.(this.#toResolved(incident));
        this.#sql.exec(
          `UPDATE ${INCIDENTS} SET resolve_delivery = 'done', delivery_error = NULL
           WHERE id = ?`,
          id
        );
        return;
      } catch (error) {
        this.#report({
          alert: incident.alert,
          phase: kind === "fire" ? "onFire" : "onResolve",
          incidentId: id,
          error
        });
        this.#sql.exec(
          `UPDATE ${INCIDENTS} SET delivery_error = ? WHERE id = ?`,
          message(error),
          id
        );
        return;
      }
    }
  }

  #toIncident(row: IncidentRow): Incident {
    return {
      id: row.id,
      alert: row.alert,
      key: row.key,
      title: row.title,
      firedAt: new Date(row.fired_at),
      row: JSON.parse(row.row) as Row
    };
  }

  #toResolved(row: IncidentRow): ResolvedIncident<Row, string, Json> {
    const resolvedAt = row.resolved_at ?? this.#now();
    return {
      ...this.#toIncident(row),
      resolvedAt: new Date(resolvedAt),
      durationMs: resolvedAt - row.fired_at,
      reason: (row.reason ?? "recovered") as ResolveReason,
      lastRow: parse<Row>(row.last_row),
      fired: parse<Json>(row.fired)
    };
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────

  #prune(): void {
    const cutoff = this.#now() - toMs(this.#options.retention, 7 * 86_400_000);
    this.#sql.exec(
      `DELETE FROM ${INCIDENTS}
       WHERE status = 'resolved' AND resolved_at < ?
         AND fire_delivery != 'pending' AND coalesce(resolve_delivery, 'skipped') != 'pending'`,
      cutoff
    );
  }

  /** Point the Durable Object alarm at the next check or pending delivery. */
  async #schedule(): Promise<void> {
    const next = this.#sql
      .exec<{ at: number | null }>(
        `SELECT min(at) AS at FROM (
           SELECT max(coalesce(retry_at, next_run_at), coalesce(paused_until, 0)) AS at
             FROM ${ALERTS} WHERE failed = 0 AND coalesce(paused_until, 0) < ?
           UNION ALL
           SELECT ? AS at FROM ${INCIDENTS}
             WHERE fire_delivery = 'pending' OR resolve_delivery = 'pending'
         )`,
        FOREVER,
        this.#now()
      )
      .one().at;
    const storage = this.#ctx.storage;
    if (next === null) {
      await storage.deleteAlarm();
      return;
    }
    if ((await storage.getAlarm()) !== next) await storage.setAlarm(next);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #entry(name: string): Entry {
    const entry = this.#entries.get(name);
    if (!entry) throw new Error(`Unknown alert "${name}"`);
    return entry;
  }

  #incident(id: string): IncidentRow | undefined {
    return this.#sql
      .exec<IncidentRow>(`SELECT * FROM ${INCIDENTS} WHERE id = ?`, id)
      .toArray()[0];
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #report(
    error: Omit<AlertError, "incidentId"> & { incidentId?: string }
  ): void {
    const report: AlertError = { incidentId: undefined, ...error };
    try {
      if (this.#options.onError) this.#options.onError(report);
      else
        console.error(
          `[durable-alerts] ${report.alert} ${report.phase} failed`,
          report.incidentId ?? "",
          report.error
        );
    } catch {
      // Never let error reporting break evaluation.
    }
  }

  /** Run one evaluation or delivery pass at a time. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => {});
    return run;
  }
}

/**
 * Attach alerts to a Durable Object. Declare them with `.watch()` in a field
 * initializer, and forward the object's `alarm()` to `alerts.alarm()`.
 *
 * ```ts
 * export class Oncall extends DurableObject<Env> {
 *   alerts = alerts(this.ctx, { sql: this.env.ANALYTICS_SQL }).watch({ ... });
 *   alarm() { return this.alerts.alarm(); }
 * }
 * ```
 */
export function alerts(
  ctx: DurableObjectState,
  options: AlertsOptions
): Alerts {
  return new AlertsRuntime(ctx, options);
}

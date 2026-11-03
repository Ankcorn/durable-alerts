import { DurableObject } from "cloudflare:workers";
import { DurabilityAlarms, DurabilityScheduler } from "durability";
import {
  alerts,
  defineAlert,
  sql,
  type AnalyticsSql,
  type Row
} from "../index";

/**
 * The tests fake `Date` (shared with this worker, which runs in the same
 * isolate) so durability's scheduler and the alerts share one clock. Far in
 * the future so workerd never runs an alarm on its own.
 */
export const BASE = Date.UTC(2100, 0, 1);

type Call = {
  kind: "fire" | "resolve";
  alert: string;
  id: string;
  key: string;
  reason?: string;
  fired?: { pageId: string } | null;
  lastRow?: Row;
};

export const byScript = defineAlert({
  name: "by-script",
  query: sql<{ scriptName: string; rate: number }>`
    -- alert:by-script
    SELECT scriptName, rate FROM t WHERE ${sql.window} GROUP BY scriptName`,
  every: "1m",
  window: "5m",
  groupBy: (row) => row.scriptName,
  fireWhen: { rate: { above: 0.05 } },
  resolveWhen: { rate: { below: 0.01 } },
  fireAfter: "2m",
  resolveAfter: "5m"
});

export class TestAlerts extends DurableObject {
  rows: Record<string, Row[]> = {};
  failures = { fire: 0, resolve: 0 };
  queryLog: Array<{ alert: string; start: string; end: string }> = [];
  log: Call[] = [];
  queryError: string | undefined;

  fakeSql: AnalyticsSql = {
    query: async <T extends Record<string, unknown>>(request: {
      query: string;
      params?: Readonly<Record<string, unknown>>;
    }) => {
      const alert = /-- alert:([\w-]+)/.exec(request.query)?.[1] ?? "";
      this.queryLog.push({
        alert,
        start: String(request.params?.start),
        end: String(request.params?.end)
      });
      if (this.queryError) throw new Error(this.queryError);
      return { data: (this.rows[alert] ?? []) as T[] };
    }
  };

  alerts = alerts(this.ctx, {
    sql: this.fakeSql,
    onError: () => {}
  }).watch(byScript, {
    onFire: (incident) => {
      this.log.push({
        kind: "fire",
        alert: incident.alert,
        id: incident.id,
        key: incident.key
      });
    },
    onResolve: (incident) => {
      this.log.push({
        kind: "resolve",
        alert: incident.alert,
        id: incident.id,
        key: incident.key,
        reason: incident.reason
      });
    }
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Simulates a deploy that deletes the "errors" alert from the code.
    if (ctx.storage.kv.get("drop-errors")) return;
    this.alerts.watch({
      name: "errors",
      query: sql<{ errors: number }>`
        -- alert:errors
        SELECT count() AS errors FROM t WHERE ${sql.window}`,
      every: "1m",
      window: "5m",
      fireWhen: { errors: { above: 50 } },
      onFire: async (incident) => {
        this.#maybeFail("fire");
        this.log.push({
          kind: "fire",
          alert: incident.alert,
          id: incident.id,
          key: incident.key
        });
        return { pageId: `page:${incident.id}` };
      },
      onResolve: async (incident) => {
        this.#maybeFail("resolve");
        this.log.push({
          kind: "resolve",
          alert: incident.alert,
          id: incident.id,
          key: incident.key,
          reason: incident.reason,
          fired: incident.fired ?? null,
          lastRow: incident.lastRow
        });
      }
    });
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.alerts.alarm(info);
  }

  #maybeFail(kind: "fire" | "resolve") {
    if (this.failures[kind] > 0) {
      this.failures[kind]--;
      throw new Error(`${kind} failed`);
    }
  }

  // ── test controls ──
  dropErrorsOnNextStart() {
    this.ctx.storage.kv.put("drop-errors", true);
  }
  setRows(alert: string, rows: Row[]) {
    this.rows[alert] = rows;
  }
  failNext(kind: "fire" | "resolve", times: number) {
    this.failures[kind] = times;
  }
  setQueryError(error: string | undefined) {
    this.queryError = error;
  }
  calls() {
    return this.log;
  }
  queries() {
    return this.queryLog;
  }
  async alarmAt() {
    return this.ctx.storage.getAlarm();
  }
  status() {
    return this.alerts.status();
  }
  incidents(status?: "firing" | "resolving" | "resolved" | "open") {
    return this.alerts.incidents(status ? { status } : {});
  }
  check(name: string) {
    return this.alerts.check(name);
  }
  resolve(id: string) {
    return this.alerts.resolve(id);
  }
  pause(name: string) {
    return this.alerts.pause(name);
  }
  resume(name: string) {
    return this.alerts.resume(name);
  }
}

/** Alerts sharing the object's scheduler with its own named alarms. */
export class SharedAlerts extends DurableObject {
  remindersRun = 0;
  scheduler = new DurabilityScheduler({ context: this.ctx });
  alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      remind: async () => {
        this.remindersRun++;
      }
    }
  });
  alerts = alerts(this.ctx, {
    sql: { query: async () => ({ data: [] }) },
    scheduler: this.scheduler,
    onError: () => {}
  }).watch(byScript, { onFire: () => {} });

  alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }

  async ready() {
    await this.alerts.ready;
  }
  remindAt(at: number) {
    return this.alarms.remind(at);
  }
  reminders() {
    return this.remindersRun;
  }
  status() {
    return this.alerts.status();
  }
}

export default {
  fetch() {
    return new Response("durable-alerts tests");
  }
} satisfies ExportedHandler;

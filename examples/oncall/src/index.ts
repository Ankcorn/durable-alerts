import { DurableObject } from "cloudflare:workers";
import { alerts, defineAlert, sql } from "durable-alerts";

/** One incident per script whose 5xx rate stays above 5%. */
const errorRate = defineAlert({
  name: "error-rate",
  query: sql<{
    scriptName: string;
    errors: number;
    requests: number;
    rate: number;
  }>`
    SELECT scriptName,
           countIf(httpStatus >= 500) AS errors,
           count()                AS requests,
           countIf(httpStatus >= 500) / count() AS rate
    FROM logs.workersLogs
    WHERE ${sql.window}
    GROUP BY scriptName
    HAVING count() >= 20`,
  every: "1m",
  window: "5m",
  delay: "30s",
  groupBy: (row) => row.scriptName,
  fireWhen: { rate: { above: 0.05 } },
  resolveWhen: { rate: { below: 0.01 } },
  fireAfter: "2m",
  resolveAfter: "5m",
  title: (row, script) =>
    `${script}: ${(row.rate * 100).toFixed(1)}% of requests failing`
});

export class Oncall extends DurableObject<Cloudflare.Env> {
  alerts = alerts(this.ctx, { sql: this.env.ANALYTICS_SQL })
    .watch({
      name: "demo-script-errors",
      // Replace this query's script name with a Worker in your account.
      query: sql<{ errors: number }>`
        SELECT count() AS errors
        FROM logs.workersLogs
        WHERE ${sql.window}
          AND scriptName = 'analytics-sql-binding-debug'
          AND httpStatus >= 500`,
      every: "1m",
      window: "1d",
      fireWhen: { errors: { atLeast: 1 } },
      title: (row) =>
        `analytics-sql-binding-debug: ${row.errors} server errors in the last day`,
      onFire: (incident) => {
        console.log("FIRE", incident.title, incident.row);
        return { openedBy: "demo" };
      },
      onResolve: (incident) => console.log("RESOLVE", incident.title)
    })
    .watch({
      name: "high-error-volume",
      query: sql<{ errors: number }>`
        SELECT count() AS errors
        FROM logs.workersLogs
        WHERE ${sql.window} AND httpStatus >= 500`,
      every: "1m",
      window: "5m",
      fireWhen: { errors: { above: 50 } },
      onFire: async (incident) => {
        console.log("FIRE", incident.title, incident.row);
        return { openedBy: "example" };
      },
      onResolve: async (incident) => {
        console.log("RESOLVE", incident.title, incident.reason, incident.fired);
      }
    })
    .watch(errorRate, {
      onFire: (incident) => console.log("FIRE", incident.title),
      onResolve: (incident) =>
        console.log("RESOLVE", incident.title, `${incident.durationMs}ms`)
    });

  alarm(info?: AlarmInvocationInfo) {
    return this.alerts.alarm(info);
  }

  async ensure() {
    await this.alerts.ready;
  }
  status() {
    return this.alerts.status();
  }
  incidents() {
    return this.alerts.incidents();
  }
  check(name: string) {
    return this.alerts.check(name);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oncall = env.ONCALL.getByName("oncall");
    await oncall.ensure();
    switch (url.pathname) {
      case "/ensure":
        return Response.json({ ready: true });
      case "/status":
        return Response.json(await oncall.status());
      case "/incidents":
        return Response.json(await oncall.incidents());
      case "/check": {
        const name = url.searchParams.get("name") ?? "high-error-volume";
        return Response.json(await oncall.check(name));
      }
      default:
        return new Response("GET /ensure, /status, /incidents, /check?name=", {
          status: 404
        });
    }
  },
  async scheduled(_controller, env) {
    await env.ONCALL.getByName("oncall").ensure();
  }
} satisfies ExportedHandler<Cloudflare.Env>;

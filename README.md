# durable-alerts

Threshold alerts over Workers Analytics SQL that live inside any Cloudflare Durable Object. No base class to extend.

```ts
import { DurableObject } from "cloudflare:workers";
import { alerts, sql } from "durable-alerts";

export class Oncall extends DurableObject<Env> {
  alerts = alerts(this.ctx, { sql: this.env.ANALYTICS_SQL }).watch({
    name: "high-error-volume",
    query: sql<{ errors: number }>`
      SELECT count() AS errors FROM logs.workersLogs
      WHERE ${sql.window} AND httpStatus >= 500`,
    every: "1m",
    window: "5m",
    fireWhen: { errors: { above: 50 } },
    onFire: async (incident) => ({ pageId: await page(incident) }),
    onResolve: async (incident) => closePage(incident.fired.pageId)
  });

  alarm() {
    return this.alerts.alarm();
  }
}
```

- An **alert** is a query plus a condition, checked on a schedule.
- An **incident** is one breach of an alert. It fires once and resolves once.
- **`onFire`** runs when an incident opens. Whatever it returns is saved and passed to **`onResolve`** as `incident.fired`, so you can close exactly what you opened.

## Install

```sh
npm install durable-alerts
```

The Durable Object must use SQLite storage (`new_sqlite_classes` in its migration).

## How it works

`alerts(ctx, options)` creates its own tables in the object's SQLite database. `.watch()` declares an alert. Declarations run on every wake, so **the code is the source of truth**: a deploy that changes an alert updates it in place, and a deploy that removes one deletes it and closes its open incidents without calling a handler.

Each check runs the query with `$start` and `$end` set to the window, anchored to the scheduled time (so a late alarm doesn't shift the window). `sql.window` expands to `timestamp >= $start AND timestamp < $end`; use `sql.windowOn("column")` for another time column.

### One incident per key

`groupBy` opens one incident per key from a single query, so several can be open at once:

```ts
import { defineAlert, sql } from "durable-alerts";

export const errorRate = defineAlert({
  name: "error-rate",
  query: sql<{ scriptName: string; rate: number }>`
    SELECT scriptName, countIf(httpStatus >= 500) / count() AS rate
    FROM logs.workersLogs WHERE ${sql.window}
    GROUP BY scriptName HAVING count() >= 20`,
  every: "1m",
  window: "5m",
  groupBy: (row) => row.scriptName,
  fireWhen: { rate: { above: 0.05 } }, // open above 5%
  resolveWhen: { rate: { below: 0.01 } }, // close below 1%
  fireAfter: "2m", // ignore blips
  resolveAfter: "5m" // don't flap
});

// in the Durable Object
alerts(this.ctx, { sql: this.env.ANALYTICS_SQL }).watch(errorRate, {
  onFire: (incident) => notify(`${incident.key} is failing`),
  onResolve: (incident) => notify(`${incident.key} recovered`)
});
```

When a key that has an open incident returns no row, it counts as recovered (`onNoData: "resolve"`, the default). That suits queries like `WHERE httpStatus >= 500 GROUP BY scriptName`, where a healthy script returns no row. Set `onNoData: "keep"` to leave such incidents open.

### Options

| Option         | Default        | Meaning                                                                         |
| -------------- | -------------- | ------------------------------------------------------------------------------- |
| `every`        | required       | How often to run the query (at least `"10s"`).                                  |
| `window`       | `every`        | How far back `sql.window` looks (at most `"31d"`).                              |
| `delay`        | `"0s"`         | Shift the window back to allow for ingestion lag.                               |
| `fireWhen`     | required       | `{ column: { above \| atLeast \| below \| atMost: n } }` or `(row) => boolean`. |
| `resolveWhen`  | not `fireWhen` | A separate threshold for resolving.                                             |
| `fireAfter`    | `"0s"`         | How long the breach must last before firing.                                    |
| `resolveAfter` | `"0s"`         | How long the recovery must last before resolving.                               |
| `groupBy`      | none           | One incident per key.                                                           |
| `onNoData`     | `"resolve"`    | What a missing row means for an open incident.                                  |
| `title`        | name (and key) | `(row, key) => string`.                                                         |

Declarative conditions compare numbers, and numeric strings count as numbers, since ClickHouse returns 64-bit integers such as `count()` as strings.

### Handlers run at least once

The incident is saved before `onFire` runs. If a handler throws, or the object restarts mid-call, it is retried with exponential backoff (5 attempts from `10s` by default; set `retry: { attempts, backoff }`). Dedupe side effects on `incident.id`, which stays the same for the life of the incident.

`onResolve` always runs after `onFire` has succeeded. If `onFire` runs out of attempts, `onResolve` is skipped, since nothing was opened.

Handlers run inside the alarm, so hand long work to a [Workflow](https://developers.cloudflare.com/workflows/) or another Durable Object, using `incident.id` as the instance id.

### Operator API

Expose these over RPC for a dashboard or a chat tool:

```ts
await this.alerts.status(); // alerts, next check, last error, open count
await this.alerts.incidents({ status: "open" });
await this.alerts.check("error-rate"); // run now, outside the schedule
await this.alerts.resolve(incidentId); // calls onResolve with reason "manual"
await this.alerts.pause("error-rate", "1h");
await this.alerts.resume("error-rate");
```

Resolved incidents are kept for 7 days (`retention` option).

### Testing

`defineAlert(...).evaluate(rows, openKeys)` evaluates rows without a Durable Object:

```ts
errorRate.evaluate([{ scriptName: "api", rate: 0.09 }], ["web"]);
// => { fire: ["api"], resolve: ["web"] }
```

Pass any object with a `query()` method as `sql`, and `now: () => number` to control time.

## Things to know

- **It owns the object's alarm.** Forward `alarm()` to `alerts.alarm()`. Sharing the alarm with other timers is planned.
- **The first check needs a wake.** A Durable Object only runs when something calls it, so call it once after deploying, for example from a cron trigger that awaits `alerts.ready`.
- **One `alerts()` per object.** The tables are named `_durable_alerts*`.

## Run the oncall example

Use Node.js 24 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler login
pnpm --filter durable-alerts-example-oncall dev
```

The example uses `@cloudflare/config` and queries real account data through the remote Analytics binding. Its Durable Object and incidents stay local during development.

```sh
curl http://localhost:8787/status
curl 'http://localhost:8787/check?name=demo-script-errors'
curl http://localhost:8787/incidents
```

`demo-script-errors` checks for a server error from `analytics-sql-binding-debug` in the last day. Replace that script name in `examples/oncall/src/index.ts` with a Worker in your account. Fired and resolved incidents are logged in the dev terminal.

Any endpoint wakes the alert scheduler. The daily cron also wakes it after deployment; Durable Object alarms handle the individual alert intervals.

## License

MIT

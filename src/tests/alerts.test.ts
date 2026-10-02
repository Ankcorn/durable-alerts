import {
  env,
  evictDurableObject,
  runDurableObjectAlarm
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineAlert, sql } from "../index";
import { BASE, byScript } from "./worker";

const MINUTE = 60_000;
let counter = 0;

function object() {
  return env.ALERTS.getByName(`test-${++counter}`);
}

type Stub = ReturnType<typeof object>;

/** Move the fake clock forward, then run the scheduled alarm. */
async function tick(stub: Stub, ms = MINUTE) {
  await stub.advance(ms);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

describe("alerts", () => {
  it("schedules the first check when the object is created", async () => {
    const stub = object();
    expect(await stub.alarmAt()).toBe(BASE);
    const status = await stub.status();
    expect(status.map((s) => s.name)).toEqual(["by-script", "errors"]);
  });

  it("fires once while breached and resolves once with what onFire returned", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: 90 }]);

    await tick(stub, 0);
    await tick(stub);
    await tick(stub);
    let calls = await stub.calls();
    expect(calls.filter((c) => c.alert === "errors")).toHaveLength(1);
    const [fired] = calls;
    expect(fired).toMatchObject({ kind: "fire", key: "", attempt: 1 });
    expect(fired?.id).toBe(`errors/${BASE}`);

    await stub.setRows("errors", [{ errors: 3 }]);
    await tick(stub);
    calls = await stub.calls();
    expect(calls[1]).toMatchObject({
      kind: "resolve",
      id: fired?.id,
      reason: "recovered",
      fired: { pageId: `page:errors/${BASE}` },
      lastRow: { errors: 3 }
    });
    expect(await stub.incidents("open")).toEqual([]);
    const [incident] = await stub.incidents("resolved");
    expect(incident?.resolvedAt?.getTime()).toBe(BASE + 3 * MINUTE);
  });

  it("treats numeric strings as numbers, since ClickHouse returns UInt64 as strings", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: "51" }]);
    await tick(stub, 0);
    expect(await stub.calls()).toHaveLength(1);
  });

  it("anchors the query window to the scheduled time", async () => {
    const stub = object();
    await tick(stub, 0);
    await tick(stub, MINUTE + 5_000); // the alarm ran 5s late
    const queries = (await stub.queries()).filter((q) => q.alert === "errors");
    expect(queries[0]).toEqual({
      alert: "errors",
      start: new Date(BASE - 5 * MINUTE).toISOString(),
      end: new Date(BASE).toISOString()
    });
    expect(queries[1]?.end).toBe(new Date(BASE + MINUTE).toISOString());
    expect(await stub.alarmAt()).toBe(BASE + 2 * MINUTE);
  });

  it("opens one incident per key from a single grouped query", async () => {
    const stub = object();
    const rows = (rates: Record<string, number>) =>
      stub.setRows(
        "by-script",
        Object.entries(rates).map(([scriptName, rate]) => ({
          scriptName,
          rate
        }))
      );
    const fired = async () =>
      (await stub.calls())
        .filter((c) => c.alert === "by-script" && c.kind === "fire")
        .map((c) => c.key);
    const resolved = async () =>
      (await stub.calls())
        .filter((c) => c.alert === "by-script" && c.kind === "resolve")
        .map((c) => `${c.key}:${c.reason}`);

    // t=0: api breaches, web is healthy. fireAfter is 2m, so nothing fires yet.
    await rows({ api: 0.09, web: 0.001 });
    await tick(stub, 0);
    expect(await fired()).toEqual([]);

    // t=1m: cron starts breaching too.
    await rows({ api: 0.09, web: 0.001, cron: 0.2 });
    await tick(stub);
    expect(await fired()).toEqual([]);

    // t=2m: api has breached for 2m and fires.
    await tick(stub);
    expect(await fired()).toEqual(["api"]);

    // t=3m: cron fires. api is between the thresholds, so it stays firing.
    await rows({ api: 0.03, web: 0.001, cron: 0.2 });
    await tick(stub);
    expect(await fired()).toEqual(["api", "cron"]);
    const open = await stub.incidents("open");
    expect(open.map((i) => i.key).toSorted()).toEqual(["api", "cron"]);
    expect(open.every((i) => i.status === "firing")).toBe(true);

    // t=4m: api recovers below 1%, cron disappears from the results.
    await rows({ api: 0.005, web: 0.001 });
    await tick(stub);
    expect((await stub.incidents("resolving")).length).toBe(2);

    // resolveAfter is 5m.
    for (let i = 0; i < 4; i++) await tick(stub);
    expect(await resolved()).toEqual([]);
    await tick(stub);
    expect((await resolved()).toSorted()).toEqual([
      "api:recovered",
      "cron:no-data"
    ]);
  });

  it("returns a resolving incident to firing if the breach comes back", async () => {
    const stub = object();
    const set = (rate: number) =>
      stub.setRows("by-script", [{ scriptName: "api", rate }]);
    await set(0.09);
    await tick(stub, 0);
    await tick(stub);
    await tick(stub);
    await set(0.001);
    await tick(stub);
    expect((await stub.incidents("open"))[0]?.status).toBe("resolving");
    await set(0.02);
    await tick(stub);
    expect((await stub.incidents("open"))[0]?.status).toBe("firing");
  });

  it("does not retry a failed onFire and skips onResolve", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: 90 }]);
    await stub.failNext("fire", 1);
    await tick(stub, 0);
    expect((await stub.incidents("open"))[0]?.deliveryError).toBe(
      "fire failed"
    );
    expect(await stub.alarmAt()).toBe(BASE + MINUTE);
    await tick(stub);
    expect(await stub.calls()).toEqual([]);
    await stub.setRows("errors", [{ errors: 0 }]);
    await tick(stub);
    expect(await stub.calls()).toEqual([]);
    expect((await stub.incidents("resolved"))[0]?.deliveryError).toBe(
      "fire failed"
    );
  });

  it("resolves by hand", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: 90 }]);
    await tick(stub, 0);
    const [incident] = await stub.incidents("open");
    await stub.resolve(incident!.id);
    const calls = await stub.calls();
    expect(calls[1]).toMatchObject({ kind: "resolve", reason: "manual" });
  });

  it("checks on demand without moving the schedule", async () => {
    const stub = object();
    await tick(stub, 0);
    await stub.setRows("errors", [{ errors: 90 }]);
    const result = await stub.check("errors");
    expect(result.fired).toHaveLength(1);
    expect(await stub.alarmAt()).toBe(BASE + MINUTE);
  });

  it("records query errors and keeps the schedule", async () => {
    const stub = object();
    await stub.setQueryError("table not found");
    await tick(stub, 0);
    const errors = (await stub.status()).find((s) => s.name === "errors");
    expect(errors?.lastError).toBe("table not found");
    expect(await stub.alarmAt()).toBe(BASE + MINUTE);
  });

  it("does not redeliver a failed callback after a restart", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: 90 }]);
    await stub.failNext("fire", 1);
    await tick(stub, 0);
    await evictDurableObject(stub);
    await stub.setRows("errors", [{ errors: 90 }]);
    await tick(stub);
    expect(await stub.calls()).toEqual([]);
    expect((await stub.incidents("open"))[0]?.deliveryError).toBe(
      "fire failed"
    );
  });

  it("removes alerts that are no longer declared", async () => {
    const stub = object();
    await stub.setRows("errors", [{ errors: 90 }]);
    await tick(stub, 0);
    expect(await stub.incidents("open")).toHaveLength(1);

    await stub.dropErrorsOnNextStart();
    await evictDurableObject(stub);

    expect((await stub.status()).map((s) => s.name)).toEqual(["by-script"]);
    const [incident] = await stub.incidents();
    expect(incident).toMatchObject({
      status: "resolved",
      reason: "alert-removed"
    });
    expect(await stub.calls()).toEqual([]);
  });

  it("stops checking a paused alert", async () => {
    const stub = object();
    await tick(stub, 0);
    await stub.pause("errors");
    await stub.pause("by-script");
    expect(await stub.alarmAt()).toBeNull();
    await stub.advance(30_000);
    await stub.resume("errors"); // resuming checks straight away
    expect(await stub.alarmAt()).toBe(BASE + 30_000);
  });
});

describe("defineAlert", () => {
  it("evaluates rows without a Durable Object", () => {
    expect(
      byScript.evaluate(
        [
          { scriptName: "api", rate: 0.09 },
          { scriptName: "web", rate: 0.001 },
          { scriptName: "cron", rate: 0.03 }
        ],
        ["web", "cron", "gone"]
      )
    ).toEqual({ fire: ["api"], resolve: ["web", "gone"] });
  });

  it("rejects specs that cannot work", () => {
    const base = {
      name: "x",
      query: sql<{ n: number }>`SELECT 1 AS n WHERE ${sql.window}`,
      every: "1m" as const,
      fireWhen: { n: { above: 1 } }
    };
    expect(() => defineAlert({ ...base, name: "has space" })).toThrow(/name/);
    expect(() => defineAlert({ ...base, every: "5s" })).toThrow(/at least 10s/);
    expect(() =>
      defineAlert({ ...base, query: sql<{ n: number }>`SELECT 1 AS n` })
    ).toThrow(/window/);
    expect(() => defineAlert({ ...base, window: "40d" })).toThrow(/31d/);
  });
});

describe("sql", () => {
  it("turns interpolated values into parameters", () => {
    const query = sql`SELECT 1 WHERE ${sql.window} AND a = ${"x"} AND b > ${2}`;
    expect(query.text).toBe(
      "SELECT 1 WHERE timestamp >= $start AND timestamp < $end AND a = $p1 AND b > $p2"
    );
    expect(query.params).toEqual({ p1: "x", p2: 2 });
  });

  it("supports another time column", () => {
    expect(sql`WHERE ${sql.windowOn("ts")}`.text).toBe(
      "WHERE ts >= $start AND ts < $end"
    );
    expect(() => sql.windowOn("ts; DROP")).toThrow();
  });
});

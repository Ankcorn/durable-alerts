import { bindings, defineConfig, exports, triggers } from "@cloudflare/config";

export default defineConfig({
  worker: {
    name: "durable-alerts-oncall",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-09-22",
    env: {
      ANALYTICS_SQL: { type: "analytics", dev: { remote: true } },
      ONCALL: bindings.durableObject({
        worker: "durable-alerts-oncall",
        exportName: "Oncall"
      })
    },
    exports: {
      Oncall: exports.durableObject({ storage: "sqlite" })
    },
    triggers: [triggers.scheduled({ schedule: "0 0 * * *" })],
    observability: { enabled: true }
  }
});

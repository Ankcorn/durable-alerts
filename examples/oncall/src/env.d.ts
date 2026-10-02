import type { Oncall } from "./index";

declare global {
  namespace Cloudflare {
    interface Env {
      ANALYTICS_SQL: AnalyticsSQLBinding;
      ONCALL: DurableObjectNamespace<Oncall>;
    }
  }
}

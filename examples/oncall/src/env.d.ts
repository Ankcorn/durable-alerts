import type { Oncall } from "./index";

declare global {
  namespace Cloudflare {
    interface Env {
      ANALYTICS: AnalyticsSQLBinding;
      ONCALL: DurableObjectNamespace<Oncall>;
    }
  }
}

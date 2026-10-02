declare namespace Cloudflare {
  interface Env {
    ALERTS: DurableObjectNamespace<import("./worker").TestAlerts>;
  }
}

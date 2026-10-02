---
"durable-alerts": minor
---

Attempt onFire and onResolve once, leaving retries to the caller. Remove retry policies and delivery attempt arguments, and retain handler failures on incidents without redelivering after restarts.

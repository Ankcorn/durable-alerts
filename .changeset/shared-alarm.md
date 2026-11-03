---
"durable-alerts": minor
---

Schedule checks through a durability named alarm, and add a `scheduler` option so alerts share the Durable Object's alarm with other durability helpers, including the object's own `DurabilityAlarms`. Without it, alerts create a private scheduler; forwarding `alarm()` to `alerts.alarm()` still works.

Breaking: remove the `now` option. Alerts read the time from `Date.now()`, as durability does; control it in tests with fake timers.

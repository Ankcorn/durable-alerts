---
"durable-alerts": minor
---

Add an `alarm` option that schedules checks through a named alarm, such as a durability `DurabilityAlarms` method, so alerts can share the Durable Object's alarm with other timers. Without it, alerts keep using the Durable Object alarm.

Breaking: remove the `now` option. Alerts read the time from `Date.now()`; control it in tests with fake timers.

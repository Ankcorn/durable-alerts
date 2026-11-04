---
"durable-alerts": minor
---

Schedule checks through a durability named alarm built from the object's context. With durability's one scheduler per Durable Object, alerts share the alarm with the object's own durability helpers (named alarms, durable operations) without a `scheduler` option: forward `alarm()` to `alerts.alarm()` or to any of them. durability is now a peer dependency, so a Worker installs it once.

Breaking: remove the `now` option. Alerts read the time from `Date.now()`, as durability does; control it in tests with fake timers.

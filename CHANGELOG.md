# durable-alerts

## 0.2.0

### Minor Changes

- 00d093c: Retry SQL errors marked retryable with persistent exponential backoff. Preserve the original query and time parameters across retries and restarts, and process overdue scheduled windows in order without blocking other alerts. Handler callbacks are not retried.
- 52a5430: Attempt onFire and onResolve once, leaving retries to the caller. Remove retry policies and delivery attempt arguments, and retain handler failures on incidents without redelivering after restarts.
  
  Persist evaluation failures and disable the affected alert until explicitly resumed, allowing other alerts and callbacks to continue.

### Patch Changes

- 1b98a0c: Discard saved SQL retries when a deployment changes the query, parameters, window, delay, or check interval, and restart the updated query from now.
- aef0bee: Process pending retries and overdue scheduled windows before newer manual checks, preventing historical evaluations from changing incidents opened by a later check.
- 871c8dd: Skip paused windows when an alert resumes or a timed pause expires, while preserving any pending SQL retry's original window.
- 66fbdc2: Use UUIDs for incident IDs so incidents opened for the same alert and key in one millisecond do not collide.

## 0.1.0

### Minor Changes

- 7c40f34: First release: threshold alerts over Analytics SQL inside any Durable Object, with grouped incidents, separate fire and resolve thresholds, fireAfter/resolveAfter, at-least-once onFire/onResolve with retries, and an operator API.

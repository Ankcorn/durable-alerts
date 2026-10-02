---
"durable-alerts": minor
---

Retry SQL errors marked retryable with persistent exponential backoff. Preserve the original query and time parameters across retries and restarts, and process overdue scheduled windows in order without blocking other alerts. Handler callbacks are not retried.

# Heartopia weather scheduler

## Schedule (JST)

- 07:00 primary morning run
- 07:10 independent snooze run
- 19:00 primary evening run
- 19:10 independent snooze run
- `workflow_dispatch` for a manual retry from GitHub Actions

The +10 minute snooze is a separate cron entry. It does not wait inside the primary job, so it can still start when the primary scheduled run itself failed to start.

## Slot guard

Each day has a `morning` and `evening` slot. A successful slot writes a marker to its audit Issue. A snooze/manual run first checks that marker and exits without repeating the slot when it already succeeded.

## Retry policy

- Technical failure: workflow fails; Discord failure notification is sent; +10 minute cron can retry.
- No discovery candidates: treated as failure so the +10 minute cron can retry once.
- Same previously-seen discovery source set: treated as a completed run; do not resend the same source set.
- After the snooze also fails, wait for the next regular slot or use `Run workflow` manually.

## Duplicate protection

There are two independent guards:

1. Update-slot guard prevents the same morning/evening slot from being executed again after success.
2. Discovery fingerprint prevents an identical set of source candidates from being treated as new information.

The final pending submission keeps its own existing duplicate protections. A later reviewed weather payload should only produce a new pending report when its saved weather data is actually different.

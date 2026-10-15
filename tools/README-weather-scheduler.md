# Heartopia weather scheduler

## Forecast coverage

Morning/evening runs require image-verified weather covering 06:00/18:00 on the target date. The image does not have to start at that exact hour: a same-date 00:00 forecast also covers those times. Keep its actual `startSlot` when preparing pending; never relabel it as 06:00/18:00. Different-date, future-start, incomplete, and unverified forecasts remain rejected.

X raw images must be bound to a photo/video link for the exact discovered status. Unscoped network images and quoted-post images are not accepted as that status's evidence. No paid model API is used in this scheduled path.

## Schedule (JST)

- 07:00 primary morning run
- 07:10 independent snooze run
- 19:00 primary evening run
- 19:10 independent snooze run
- `workflow_dispatch` for a manual retry from GitHub Actions

The +10 minute snooze is a separate cron entry. It does not wait inside the primary job, so it can still start when the primary scheduled run itself failed to start. All scheduler runs share one concurrency group so a delayed primary run and its snooze cannot race each other.

## Slot guard

Each day has a `morning` and `evening` slot. A slot is marked successful only when public discovery produced at least one candidate set. A snooze/manual run first checks that marker and exits without repeating the slot when it already succeeded.

## Retry policy

- Technical failure on the primary run: the +10 minute cron gets one independent retry.
- No discovery candidates on the primary run: treated as retryable failure, so the +10 minute cron tries again.
- Same previously-seen discovery source set: treated as a completed check; do not resend the same source set.
- Primary failure alone does not send a Discord failure alert.
- If the +10 minute snooze also fails, Discord sends one failure message with links to the failed run and the GitHub Actions `Run workflow` screen.
- A failed manual run also sends a Discord failure message.
- After the snooze fails, wait for the next regular slot or use `Run workflow` manually.

## Duplicate protection

The system uses independent guards at multiple layers:

1. Update-slot guard prevents the same morning/evening slot from being executed again after success.
2. Discovery fingerprint prevents an identical set of source candidates from being treated as a new source set.
3. Pending submission compares the actual weather payload, not only the source URL. If the same date/start slot/hourly slots/weekly values already exist in pending or approved data, no new pending report is submitted.

This allows the evening run to search again while avoiding a duplicate pending when only the morning weather data is still available online.

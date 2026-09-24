# Weather v2: isolated, evidence-first dry-run

Baseline: main `af04e0168d315fb9c99c848060baff425eb9e18d`.
Specification: Notion 「Heartopia Daily｜ゴール・現行仕様・設計図・注意点【正本】」, read 2026-09-24.

## What is retained / removed / redesigned

| Decision | Components | Reason |
|---|---|---|
| Retain unchanged | Apps Script heartbeat, dispatch, pending/Drive, Discord, admin, approval, public rendering | These form the working downstream path. V2 does not call them. |
| Reuse behind v2 validation | Existing PNG weather templates, daily/combined panel proposals, weekly panel proposal, public-host checks | Avoid rebuilding tested low-level pieces; their `ready` flag alone is insufficient. |
| Remove from v2 | Large PowerShell orchestration, stale LASTEXITCODE, same-image daily+weekly requirement, first-eight cut-off, production submit flags | Separate concerns and eliminate accidental writes. |
| Redesign | Search plans, URL merge/ranking, author diversity, exact media ownership, independent daily/weekly selection, provenance, duplicate identities | Explicit JSON boundaries and auditable failure reasons. |

## Verified diagnosis

- Latest failed main Run `35939807594` (2026-09-24): discovery returned 24 candidates; every reviewed candidate failed to produce accepted current-slot daily evidence. This was not a discovery schema failure. The top candidate was date/slot-relevant; image-level rejection needs diagnostics, not relaxed gates.
- Main collector `weather-x-embed-evidence.mjs` does not tag downloaded images with `sourceScope: exact-status`; combined/weekly readers require that tag for X. V2 records the owning status/photo link instead of blindly adding the tag to unscoped network images.
- Main `weather-scheduled-run.yml` stops complete-source search after eight candidates once daily fallback exists.
- Main `Test-UnifiedWeatherMatch` compares all weekly values even when the new candidate is daily-only. Approved inherited weeks can therefore cause a duplicate daily to appear different.
- PR #107 remains separate, unmerged. Its latest old dry-run `35696090572` completed successfully but still had weeklyCount=0. We do not equate that execution success with full acceptance.

## Contract and safety

`config.json` has replaceable search adapters. Every configured provider gets both daily and weekly queries; none is a required truth source. Candidates and unsuccessful attempts are retained. Canonical URLs merge discovery routes without losing author information. Daily and weekly receive independent bounded queues. There is no fixed author list. Unknown author identities are separate buckets. Recent history can break ties between otherwise equally ranked candidates; it is never a truth signal.

Capture uses public pages and official public X embeds. It never signs in, solves challenges, uses credentialed APIs, or calls a paid model API. X media must be linked to the exact discovered status. Ordinary pages contribute actual image bytes, not a whole-page screenshot masquerading as game UI. `page.jpg` is diagnostic only.

V2 treats legacy recognition as proposals. Daily must match the expected start slot, five template matches, and the explicit source date. Heuristic/template disagreement is rejected. Weekly must have recognizable game UI, five weather cells and independently OCR-verified date labels. Publication time is ranking metadata only; query dates and timestamps are never inserted into source text to make an old reader accept a date.

The result preserves separate daily/weekly source URLs, media URLs, source ownership, exact image hashes and review records. Conflicting accepted evidence blocks selection. Weekly absence is `not_found_in_search`, not a claim that no such image exists anywhere. Missing weeks are never fabricated.

The dry-run executable has no submit mode. The workflow has only `contents: read`, does not receive production secrets, and cannot create pending, notification or status Issues. It uploads diagnostics even on failure. `ready` means machine checks passed; `acceptance` remains `requires-artifact-review` until actual artifact inspection.

Duplicate identity is split: date + start + five daily values, plus an optional weekly date/value identity. A daily-only candidate matching an approved daily remains duplicate even if the approved record has inherited weeks. A genuinely observed new weekly forecast remains a separate change to review. This policy is local only; production duplicate logic has not changed.

## Run and review

```sh
node --test tools/weather-v2/test.mjs
node tools/weather-v2/run.mjs --date 2026-09-22 --start 06 --out /tmp/weather-v2
```

Download the workflow artifact through authenticated GitHub access. Inspect `result.json`, exact `daily.*` / `weekly.*`, `SHA256SUMS`, selected `capture.json`, `review.json`, and source content. Recompute SHA-256 after downloading. CI success alone is insufficient.

## Production connection gate

Do not merge, redeploy Apps Script, or change the heartbeat until the 9/22 artifact acceptance is complete. A future small adapter must translate the v2 result to the existing pending API and preserve both evidence objects and URLs. The current API validates one evidence image, so a multi-image contract plus admin display needs separate review; do not silently substitute a collage for original evidence. Keep read/verify and submit workflows distinct. Add server-side idempotency under the existing lock for daily-only duplicates, and notify Discord only after a confirmed new pending receipt. No automatic approval.

## Limits to measure, not hide

- The retained icon/geometry recognizers support known game UI layouts; unrecognized layouts fail closed.
- Weekly numeric-date OCR can reject readable-to-humans images. Rejections are saved for improvement without fabricated dates.
- Video-only or access-restricted pages can produce no usable image. They remain visible as unsuccessful candidates.
- Search results change over time. A historical-date run searches current public indexes; it does not claim to recreate the exact web state at 07:00 on that date.

# Admin weather automation trigger

The Heartopia Daily admin page can request a manual morning/evening weather automation run without exposing GitHub credentials in the browser.

Flow:

1. Admin page sends `requestWeatherAutomation` with the existing admin key, target date, and slot to the Apps Script backend.
2. Apps Script validates the admin key.
3. Apps Script reads `GITHUB_ACTIONS_TOKEN` from Script Properties and dispatches `weather-scheduled-run.yml` on `main`.
4. The GitHub workflow receives `slot` and `target_date` and applies the same run-key and duplicate guards as scheduled runs.

One-time backend setup after deployment:

- Create a fine-grained GitHub personal access token restricted to repository `sg-log/heartopia-daily` with repository permission **Actions: Read and write** only.
- Save it in the Apps Script project's Script Properties as `GITHUB_ACTIONS_TOKEN`.
- Deploy the updated Apps Script web app version.

Never place the GitHub token in `index.html`, LocalStorage, SessionStorage, query parameters, or spreadsheet cells.

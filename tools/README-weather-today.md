# Today-only weather and independent weekly reports

The source operator has permitted free use on Heartopia Daily with these conditions: display only the current hour and remaining hours of today; show a visible `Weather forecast by TH.GL` link beside the widget; link to the source for later days; do not publish or share the source dataset or stored history. Private records for accuracy checks and roughly two cached fetches daily are allowed. Permission evidence is held privately.

The Apps Script heartbeat retrieves forecasts around 08:00 and 19:00 JST. Current-hour display changes locally with the Japan clock. Private cache/history can retain dated forecasts, but the public `getWeatherCalendar` projection returns only today's remaining hour/category/label values, timestamps and credit. It never returns future dates, past hours, type tables, IDs, source settings or private history. A yearless table is not extrapolated past its confirmed year. Failed refreshes preserve the last valid cache, and a failed first fetch restores the previous mode.

Weekly weather remains the independent game-UI/SNS report path. The existing broad collector keeps candidate discovery and image evidence; after calendar activation, daily-only captures no longer create pending reports. Unavailable weekly evidence does not send the former daily-failure notifications. The existing approval UI and manual fallback remain available. No TH.GL forecast is merged into legacy report rows or share images/text.

Five privately configured accounts are used only by the separate comparison workflow. They are not the normal weekly discovery list. Comparisons require same-date, high-confidence game UI panels; duplicate authors/images cannot corroborate a discrepancy. Unreadable/absent posts remain unchecked. Images are stored in the existing owner-only Drive folder, read back and hash-checked. A corroborated discrepancy notifies only the dedicated personal destination; success and missing evidence stay quiet. The first post-setup comparison suppresses notifications.

Private history records are append-only: unchanged snapshots deduplicate, revisions remain, and legacy report import does not fill missing dates. Admin POST actions provide paginated history and comparison images; no public history endpoint exists. Old source URLs and screenshots must not enter public Actions logs or artifacts.

## Deployment

Deploy calendar/history modules together with API routes and scheduler changes, preserving unrelated modules. The source settings and permission reference are private. Merge the frontend and setup workflow, then check the setup result: current-day-only response, archived legacy records, retained private cache and unchanged API URL. The setup workflow uses the existing admin secret and personal weather webhook; it sends no Discord test. The gift webhook is never reused.

## Verification

`node --test tools/test-weather-calendar.mjs tools/test-weather-history.mjs tools/test-weather-calendar-crosscheck.mjs tools/test-weather-calendar-browser.mjs tools/test-weather-apps-script-scheduler.mjs`

Network, mail and notification services are mocked in these tests. Initial cloud setup and real source retrieval are verified separately; do not claim a live SNS match when the result is unchecked.

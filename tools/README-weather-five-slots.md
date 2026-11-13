# Five six-hour weather slots

The homepage starts with the current six-hour block in Japan time, highlights it, and shows the next four blocks in order. At 22:00 JST the times are **18, 00, 06, 12, 18**, with the final four on the following calendar date. Weekly and featured weather still come from game UI reports.

`weather-five-slots.gs` reads inert JSON from a public calendar page, converts only forecast facts into our own six-hour categories, and caches eight dated days privately. It does not execute remote scripts, copy images or prose, expose the annual table, or assume that the calendar repeats in another year. Special events such as meteor showers take precedence over the coarse clear-weather category. Hourly clouds within a sunny six-hour game forecast do not replace its game summary.

The existing heartbeat refreshes TH.GL first, then the independent five-slot source around **08:00 and 19:00 JST**. Each source has its own completion and bounded retry markers. Cache projection and homepage visits never fetch the upstream pages. A refresh or comparison failure preserves the previous complete forecast. Exhausting the cache or a source disagreement can notify only the existing personal weather destination, once per incident. No gift/friend webhook is used.

Public `getWeatherCalendar` retains TH.GL's existing today-only `calendar` projection and the default game-day `fiveSlots` response. With `fiveSlots=rolling`, it returns version 2 of `fiveSlots` with exactly five dated positions and source credit. A position has only its date and hour when the independent cache has no confirmed fact for it. TH.GL's permission gate and no-future public projection remain in place. The independent source configuration does **not** assert a provider permission grant. Technical availability of the future slots and provider permission to republish them are separate questions. Forecast comparisons are not observations or proof that every region/date is correct.

## Private setup

Deploy this module together with the updated API, scheduler, and history module into the **existing project and deployment**. Preserve every other live file and private configuration. A private `weatherFivePrivateDefaults_()` returns `{enabled:true, calendarYear:2026, sourceUrl:...}`. Only a private HTTPS `/calendar` URL is accepted. Credentials and configuration are never committed.

Authenticated actions: `initializeWeatherFiveSlots`, `getWeatherFiveSlotsStatus`, `refreshWeatherFiveSlots`. Initialization rolls back the configuration if initial retrieval, comparison, or private history fails. A source's schema or year must be reviewed before updating the confirmed year.

The setup workflow verifies the default public projection and the private comparison status without logging private details. `five-slot-forecast` history is append-only and independent of hourly and SNS records. At 00:00, 06:00, 12:00 and 18:00 JST the browser advances the window and requests the updated projection from our server cache. While offline or during a staged rollout, it uses only matching dated positions from its saved response and shows a dash for each missing position.

Validation: `node --test tools/test-weather-five-slots.mjs tools/test-weather-calendar.mjs tools/test-weather-history.mjs tools/test-weather-calendar-crosscheck.mjs tools/test-weather-calendar-browser.mjs tools/test-weather-apps-script-scheduler.mjs`.

# 天気候補の収集レイヤー（通信しない試作）

`weather-discovery.ps1` はCodex / browser取得層から渡された検索結果を扱う純粋なデータ処理です。検索・クロール・画像判読・ファイル保存・API送信はしません。外部依存はありません。

## 読み取り順（トークン節約）

原則として最初は `AGENTS.md` → 本README → `tools/README-weather-candidate.md` → 対応する `weather-discovery.ps1` / `weather-candidate.ps1` と `test-weather-discovery.ps1` / `test-weather-candidate.ps1` だけを読む。既読内容は再利用し、追加確認は必要箇所に絞る。天気アイコンの確認が必要な場合だけ `assets/weather-templates/` のREADMEと該当画像を参照する。他のtoolsや無関係な機能のファイルは、明確な依存関係が判明しない限り読まない。

pending送信接続を扱う場合だけ `weather-submit.ps1` / `test-weather-submit.ps1` と、既存 `apps-script/weather-api.gs`・`README-weather-api.md` のsubmit／投稿キー関連箇所を追加で読む。送信条件と1件テスト手順は `README-weather-candidate.md` の「pending送信接続」を参照する。

## 公開探索の運用手順

以下はCodex / browser取得層の手順であり、検索アダプターの実装ではない。

1. JSTの今日と朝6時基準の対象ゲーム日を記録する。検索式は `Heartopia 天気 YYYY-MM-DD` から始め、不足時は `ハートピア 天気 M月D日`、次に日付を外した `ハートピア 天気` へ展開する。既知URL・特定アカウント名は検索条件に使わない。
2. 利用可能な公開検索を少なくとも2経路試し、Yahoo!リアルタイム検索以外を必ず含める（例：Bing、Yahoo!通常検索）。標準の探索上限は3経路・各3検索式・各結果の先頭10件。経路・実際の検索式・取得日時・取得不能理由をメモリ内に記録する。
3. ゲームの天気報告・予報に関係し、対象日を含む可能性があり、ゲーム内天気パネル画像が添付されている可能性のある個別投稿を候補化する。明らかな別日、現実の天気、一般攻略、プロフィールだけの結果は除外する。日付・画像の不明点はメモに残し、対象日と画像が明示された候補から確認する。検索結果は発見の手掛かりに限り、天気の確定根拠にしない。
4. 候補をメモリ内で正規化・重複排除してからChrome DevTools MCPで直接開く。snapshotで投稿・本文の日付・画像リンクを確認し、screenshotのゲーム内パネルを主根拠として3セクションを作る。本文は日付・補助情報に使う。
5. 画像リンクが投稿へ戻る場合は、最新snapshotで実URLと投稿の同一性を確認し、投稿内の画像表示・次のメディア等を利用可能なMCP操作で一度試す。表示された画像リンクだけを使い、URLを推測しない。screenshotを再確認し、なお隠れる部分は補完せず、部分判読は `needsReview`、見えないセクションは `missing` とする。操作が利用不能ならその旨を記録する。投稿自体を直接確認できれば `confirmed` と画像の制約を記録できるが、ログイン転送等で投稿が見えなければ `failed` とする。
6. 少なくとも2経路を試し、1件の3セクション判定とreadyな時間別のdry-runが成功したら新規探索を終了する。成功しなくても探索上限または利用可能経路の枯渇で終了し、未解決事項を報告する。既に候補化した分は直接確認と履歴記録を終え、未取得をconfirmedにしない。週間・現在天気をreadyにするためだけに探索を延長しない。

## 形式

```json
{
  "discoverySource": "yahoo-web",
  "searchQuery": "Heartopia 天気 2026-09-10",
  "discoveredAt": "2026-09-10T01:00:00.0000000+00:00",
  "sourceUrl": "https://x.com/example/status/123/photo/1?s=20",
  "normalizedUrl": "https://x.com/i/status/123",
  "sourceType": "x",
  "sourceId": "123",
  "postId": "123",
  "retrievalStatus": "discovered",
  "memo": "検索結果の補足。天気の確定根拠ではない",
  "discoveryHistory": [
    {
      "discoverySource": "yahoo-web",
      "searchQuery": "Heartopia 天気 2026-09-10",
      "discoveredAt": "2026-09-10T01:00:00.0000000+00:00",
      "sourceUrl": "https://x.com/example/status/123/photo/1?s=20",
      "memo": "検索結果の補足。天気の確定根拠ではない"
    }
  ],
  "retrievalHistory": []
}
```

`discoverySource` は自由な識別子で、Yahoo、Bing、X検索、Grok、Instagram、TikTok等を列挙型で制限しません。これらの取得アダプター自体は未実装です。探索元と投稿のサービス種別 `sourceType` は別です。現時点の投稿種別はXなら `x`、その他は汎用 `web` とします。

## 正規化・統合

- `New-WeatherDiscoveryCandidate` で検索結果1件を生成し、`Merge-WeatherDiscoveryCandidates` へ配列で渡します。JSONから戻した同形式も利用できます。
- X / twitter.comの投稿はクエリ・フラグメント・`/photo/N`・`/video/N`を除き、アカウント名に依存しない `https://x.com/i/status/ID` に統一します。投稿IDは丸めず文字列で保持します。プロフィールURLから投稿IDを推定しません。
- X投稿はID優先。それ以外は正規化URLで統合します。一般Webはホスト・標準ポートをURI規則で正規化し、フラグメントを除去します。クエリ、パスの大文字小文字、末尾スラッシュ等は別ページの可能性があるため保持します。短縮URLや検索リダイレクトは解決しません。取得層で最終URLを確認してください。
- 統合候補の先頭項目は入力順の代表値です。全探索元・検索条件・元URL・日時・メモは `discoveryHistory` に残します。同じ入力を再投入した履歴も残る追記方式で、永続キューの再実行制御は未実装です。
- 元候補は変更せず、新しいオブジェクトを返します。HTTP(S)以外や資格情報入りURLは拒否します。秘密情報を入力に含めないでください。

## 直接取得と後段への接続

### 判定画像URLの自動引き継ぎ

直接確認したページの最新snapshot本文を `Add-WeatherDiscoveryRetrieval -BrowserSnapshot $snapshotText -HourlyImageUids @('取得した画像のUID')` に渡す。UIDは同じsnapshot内でhourlyForecastの判定に実際に使った画像要素だけをAIが指定する。関数は該当する `image ... url="..."` 行から公開HTTP(S) URLを抽出し、最新取得記録の `hourlySourceImageUrls` → `hourlyForecast.evidence.sourceImageUrls` → pending payloadへ自動接続する。複数画像を一括採用せず、対応不明ならUIDを指定しない。

画像がない・URLが出ない・取得失敗の場合も `-BrowserSnapshot ''` を渡すと空配列になり、以前の画像情報を流用しない。スクリーンショットファイル、data/file/javascript URL、資格情報・明示的な署名/トークン入りURL、ローカルURL、投稿へのリンクは除外する。snapshot原文やCookieを取得履歴へ保存しない。抽出関数は公開アクセスの疎通確認までは行わないため、取得層で認証なしに表示できた画像だけを選ぶ。既存の手動指定候補は後方互換のため引き続き利用できる。

現在のChrome DevTools MCPはsnapshot/screenshot取得に対応するが、DOM評価やネットワーク応答の取得は提供されていない。Xでsnapshotに画像URLがなく `/photo/N` リンクしか得られない場合は安定抽出不能。取得できるのは元投稿URL・本文・画面上の画像であり、今回は空配列とする。PCなしのクラウド運用で画像自体を残すには、クラウドブラウザ等で使用画像を取得し、管理者のみ閲覧できるストレージへ保存する別設計（権限、保持期間、削除対応）が必要。今回その基盤は追加しない。

```powershell
. ./tools/weather-candidate.ps1
. ./tools/weather-discovery.ps1

# $browserResults は取得層が実際の検索結果から作る。
$discoveries = @($browserResults | ForEach-Object {
    New-WeatherDiscoveryCandidate -DiscoverySource $_.discoverySource `
        -SearchQuery $_.searchQuery -DiscoveredAt $_.discoveredAt `
        -SourceUrl $_.sourceUrl -Memo $_.memo
})
$queue = @(Merge-WeatherDiscoveryCandidates -Candidates $discoveries)

# Codexが対象をMCPで直接開いてsnapshot/screenshotを確認した後だけ記録する。
$confirmed = Add-WeatherDiscoveryRetrieval -Candidate $queue[0] `
    -Status confirmed -RetrievedAt $retrievedAt -RetrievedUrl $actualPostUrl `
    -Evidence $snapshotAndScreenshotDescription -PostedAt $displayedPostedAt

# AIが直接取得した画像から3セクションを作る。検索スニペットだけで作らない。
$candidate = ConvertTo-WeatherCandidateFromDiscovery -Discovery $confirmed `
    -CurrentWeather $current -HourlyForecast $hourly -WeeklyForecast $weekly
$result = ConvertTo-SectionedWeatherReportDryRun -Candidate $candidate
```

`retrievalStatus` は `discovered`（発見のみ）、`confirmed`（直接確認済み）、`failed`（取得失敗）。取得記録には日時・実際のURL・証拠の説明または失敗理由・表示された投稿日時を保持します。時刻には明示的なタイムゾーンが必要です。`postedAt` は直接取得記録からのみ引き継ぎ、撮影時刻へ転用しません。

複数記録がある場合は最新取得日時の状態を採用します。最新が失敗なら過去に成功していても後段接続を停止し、過去の成功証拠は履歴に残します。同時刻の記録間の順序は保証しないため、取得層は実時刻を精度付きで渡してください。単なる再発見は取得状態を変えません。

`confirmed` は取得層による申告であり、関数がブラウザを操作・認証するものではありません。確認済みURLと候補の同一性、証拠説明の有無、取得履歴をチェックします。ログイン画面への転送は確認成功にしません。

## GitHub Actions generic URL取得（第1段階）

`.github/workflows/weather-cloud-url-evidence.yml` は手動入力された公開HTTPS URLをGitHub-hosted runnerのPlaywright Chromiumで直接開き、表示画面 `direct-page.png`、最大の可視コンテンツ画像を要素単位で撮った `evidence.jpg`、取得時刻・最終URL・画像SHA-256等の `capture.json` を7日保持のartifactへ保存する。特定サービス、アカウント、既知URLによる分岐は持たず、テストURLもworkflowへ固定しない。

URLは資格情報・ポート・ローカル名・IPリテラルを拒否し、メインページとサブリソースのDNS解決結果にprivate/link-local等が混じれば遮断する。ブラウザ識別はrunnerに導入されたChromium版から通常Chrome形式を組み立て、サービス固有の偽装や分岐はしない。ログイン・challenge・CAPTCHA画面は失敗として記録し、突破操作はしない。ページHTML、Cookie、認証情報、画像URLのクエリはartifactへ保存しない。証拠JPEGは既存 `weather-evidence.ps1` の上限に合わせ512KiB以下にし、SHA-256は後段の同一性確認へ使える形式にする。

取得結果は成功・失敗とも `tools/weather-cloud-discovery.ps1` が既存 `weather-discovery.ps1` を使って `discovery-candidate.json` に変換し、同じartifactへ保存する。通常Webの成功は `retrievalStatus: confirmed`、HTTP 403やログイン壁等の失敗は `retrievalStatus: failed` となる。同じ候補形式なので、GitHub Actionsで取得可能な通常Webと、別の取得アダプターが将来必要になるSNSを、後段で分岐形式を増やさず統合できる。失敗を成功扱いにせず、後段候補への変換も既存チェックで停止する。

2026-09-14の実機確認（run `34765100475`）では、既知の公開X投稿はGitHub-hosted runnerにHTTP 403を返し、画面は白紙、`evidence.jpg` は未生成だった。challenge・login wall・CAPTCHAの表示ではなくHTTP応答段階の拒否であり、この取得層からのX直接取得は利用不能と判断する。X向けのCookie、ログインセッション、proxy、fingerprint回避は追加しない。X/SNS用の別取得アダプターは未実装のままとする。

X公式公開埋め込みの実機確認は `.github/workflows/weather-cloud-x-embed-evidence.yml` と `tools/weather-x-embed-evidence.mjs` に分離する。アダプターは公開投稿URLから投稿IDだけを検証し、`publish.twitter.com/oembed` と公式 `platform.twitter.com/widgets.js` が生成する埋め込みを、ログイン・持ち込みCookie・proxy・ブラウザ識別変更なしの一時Chromium contextで表示する。許可する通信先も公式埋め込み・syndication・メディアhostに限定し、x.com本体は開かない。成功時は投稿本文、埋め込み画面、投稿画像の証拠JPEG、SHA-256、各公式経路のHTTP状態をartifactへ保存し、既存の `weather-cloud-discovery.ps1` で共通候補へ変換する。個別画像要素を取得できない場合でも、本文とstatus IDが一致し、iframe全体の撮影が成功していれば、その投稿者・日時・本文・画像を含むiframeスクリーンショットを512KiB以下の証拠JPEGとして採用する。取得失敗は同じ形式の `failed` とし、追加回避は行わない。

両workflowは取得成功後、保存済み `evidence.jpg` だけをOpenAI Responses APIへ画像入力し、strictなJSON Schemaで時間別判定を受け取る。既定modelは固定snapshot `gpt-5.4-mini-2026-03-17`、Repository Variablesの `WEATHER_AI_MODEL` で変更できる。`OPENAI_API_KEY` はActions secretだけから渡し、`store: false`、外部検索toolなしで1回呼ぶ。画像内の文字は命令として扱わず、画像外の本文・検索snippet・capture metadataから日付や枠を補完しない。

`weather-ai-candidate.ps1` はAI出力とcaptureのSHA-256・byteSize・mimeTypeを照合し、ゲーム日、開始時刻、順序付き5枠の可視性、各枠high、許可天気、未解決0件をすべて満たす場合だけ `ready` にする。その後も既存 `ConvertTo-WeatherCandidateFromDiscovery` と `ConvertTo-SectionedWeatherReportDryRun` を再実行する。判定不能時は `weather-candidate.json` と `weather-dry-run.json` をartifactへ残して送信をskipする。現在天気と週間予報は常に `missing` で、APIへ送らない。

readyの場合だけ `weather-cloud-submit.ps1` が既存submitへ証拠画像付きで接続する。`WEATHER_POST_KEY` / `WEATHER_ADMIN_KEY` はActions secretから受け取り、既存pending確認、submit、返却IDのpending確認、管理認証付き画像再取得、SHA-256一致まで確認する。Apps ScriptもScript Lock内で `date + startSlot + sourceUrl + pending` の一致を検査し、競合実行でも既存IDを返してDrive画像や行を増やさない。承認・却下・公開は呼ばない。

現時点で公開検索と定期scheduleは未接続。実行はActions画面の `Run workflow` で `source_url` を渡す。将来の07:00 / 19:00 JST scheduleは、特定アカウント・既知URLに依存しない公開探索入力が実装されてから別途接続する。

後段候補は `discovery` に全履歴を保持します。各セクションを省略すると `missing`。画像理解や本文の曖昧さ・矛盾の分類はAI側に残し、既存の時間別安全検証を通します。現在天気と週間天気はAPIへ変換しません。既存dry-runの返却値は `discovery` を含まないため、監査用には `$candidate` と `$result` を一緒に扱ってください。

## テストと次の実機確認

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-discovery.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-candidate.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-cloud-discovery.ps1
node --test ./tools/test-weather-ai-interpret.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-ai-candidate.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-cloud-submit.ps1
```

自動テストは合成データとmock通信のみ。実機確認ではアカウント名・既知URLを探索条件に使わず、得たURLをworkflowへ渡す。取得・判読・候補化のartifactとpending結果を確認し、承認は管理画面で人間が行う。

# 時間別天気のdry-run変換

`weather-candidate.ps1` の `ConvertTo-WeatherReportDryRun` は、共通候補を検証する純粋な変換関数です。収集、通信、保存、承認は行いません。既存画面・APIからは呼び出していません。新規依存はありません。

## セクション別の共通候補

新形式の入口は `ConvertTo-SectionedWeatherReportDryRun` です。共通出典を維持し、3セクションを独立評価します。旧 `ConvertTo-WeatherReportDryRun` は変更せず、時間別データの安全検証に使います。

```json
{
  "sourceType": "x",
  "sourceUrl": "https://example.com/status/example",
  "sourceId": "example",
  "postedAt": "2026-09-10 06:08 (timezone unconfirmed)",
  "memo": "画像から読み取った候補",
  "currentWeather": {
    "value": "晴",
    "capturedAt": null,
    "evidence": { "image": "右上の晴れを判読", "userConfirmed": false },
    "status": "needsReview", "confidence": "high", "unresolved": ["撮影時刻・鮮度が不明"]
  },
  "hourlyForecast": {
    "observedDate": "2026-09-10", "startSlot": "06",
    "values": {
      "slot0": { "weather": ["晴"], "evidence": ["image"] },
      "slot1": { "weather": ["晴"], "evidence": ["image"] },
      "slot2": { "weather": ["月"], "evidence": ["image"], "nightSunnyConfirmed": true },
      "slot3": { "weather": ["月"], "evidence": ["image"], "nightSunnyConfirmed": true },
      "slot4": { "weather": ["晴"], "evidence": ["image"] }
    },
    "evidence": {
      "image": "06・12・18・00・翌06の時刻とアイコンを確認。月は基準UIの晴れの夜表示。",
      "text": "本文の天気部分",
      "textAmbiguities": ["画像の判読を妨げない本文の曖昧さを記録"],
      "userConfirmed": false
    },
    "status": "ready", "confidence": "high", "unresolved": []
  },
  "weeklyForecast": {
    "values": [], "evidence": {},
    "status": "missing", "confidence": "low", "unresolved": []
  }
}
```

- 各セクションの `status` は `ready` / `needsReview` / `missing`。省略・nullのセクションは `missing` に正規化します。値は単一の `value` または複数の `values`、根拠は `evidence` に持ちます。
- `ready` は公開承認を意味しません。`currentWeather` は読取成功と現在情報として利用可能かを分けて判断します。文字が読めても撮影時刻・鮮度が不明なら、公開用の「今の天気」として `ready` にしません。現行形式では両者の専用状態を分離できないため、読めた `value`・`evidence.image`・読取の `confidence` を保持し、`status: needsReview` として理由を `unresolved` に記録します。撮影時刻は投稿日時から補完せず、APIへ変換しません。鮮度の有効期間は未定義であり、独自の閾値で利用可能と判断しません。
- この現在天気の判断は候補作成側の運用ルールです。既存関数・合成テストは撮影時刻や鮮度を自動検証しないため、テスト成功を現在情報の利用可否の証明にしません。時間別・週間は引き続き抽出候補として独立評価します。
- 画像に写らないセクションは `missing`。部分的に見える場合は見える値だけ残し、未読の時間枠は省略・null・空weatherにします。全面画像は不要です。
- 画像 ＞ 本文 ＞ 投稿間の一致。`evidence.textAmbiguities` は補足であり、画像が明確なら妨げません。同じ日時・枠に関する明確な矛盾は、そのセクションの `unresolved` に記録します。判読不能・日付不明なども該当セクションの未解決事項です。共通の日付不明などが複数セクションに影響する場合は各々に記録します。
- 関数は画像認識・自然言語の矛盾判定を行いません。候補作成側が上記分類を行います。旧形式の投稿全体の `confidence` / `unresolved` に代わり、各セクションに必ず割り当ててください。
- `ready` でも画像根拠不足・high以外・未解決事項があれば `needsReview`。他セクションの状態は波及しません。
- 週間は `values: [{ weekday: "金曜日", date: null, weather: ["雨"] }]` のように保持します。曜日→実日付の確定規則は未解決です。曜日しか読めない場合は投稿日時から日付を推定せず、`date: null`・`needsReview` とし、規則未確定を `unresolved` に記録します。規則と実日付が確定するまで `week1` 等へ変換しません。現在のdry-runは引き続き `week1`〜`weekN`へ変換せず、実日付が画像から確定した抽出候補が `ready` でも、保存仕様の不整合が解消されるまで反映対象外です。
- 月を夜晴と判断した根拠は画像説明に記録します。`nightSunnyConfirmed` はユーザー確認専用フラグではありません。旧関数による18・00の時刻チェックは維持します。

```powershell
$result = ConvertTo-SectionedWeatherReportDryRun -Candidate $candidate
$result | ConvertTo-Json -Depth 12
```

返却値は共通出典、正規化された3セクション、`hourlyDryRun`。入力は変更しません。時間別が `ready` の場合のみ、`values` を旧形式の `slots` に渡します。旧関数の検証失敗も時間別の `needsReview` に反映します。現在・週間は候補保持のみで、payloadの `weeks` は `{}`、`postKey` はありません。

テストは合成候補で上半分・下半分・全面・投稿1相当を検証します。実投稿の再取得・画像判読をテストで行うものではありません。

## 旧形式の共通候補（既存変換関数用）

候補はPowerShellオブジェクト（JSONを `ConvertFrom-Json` したものでも可）です。

| フィールド | 内容 |
| --- | --- |
| sourceType | x / web / instagram / tiktok など。特定サービスに限定しない |
| sourceUrl / sourceId | 必須の出典HTTP(S) URLと出典ID |
| postedAt | 元投稿の日時文字列。未確認なら空。観測日へ転用しない |
| observedDate | 必須のゲーム日 `yyyy-MM-dd`。暦日の撮影日とは区別する |
| startSlot | `00` / `06` / `12` / `18` |
| slots | slot0〜slot4。それぞれ `{ weather: ["晴"], evidence: ["text", "image"] }` |
| evidence.text / evidence.image | 根拠の説明文字列。画像を誰が確認したかも記録する |
| evidence.userConfirmed | ユーザー確認済みかを示すboolean。これだけでは天気の根拠にならない |
| confidence | high / medium / low。highのみpayload生成 |
| unresolved | 未解決事項の文字列配列。1件でもあれば候補全体を要確認にする |
| memo | 任意の補足 |

各枠のevidenceは候補の同名根拠を参照します。記載内容が実際にその枠を裏付けることは候補作成側で確認してください。この関数は画像や文章の真偽を判定しません。推測しかない枠を確定値として渡してはいけません。

未確認枠は省略・null・空weatherで表現でき、出力は `[]` になります。天気のある枠はtextまたはimageの参照と、その説明が必要です。未知の天気値は拒否します。月・🌙・夜晴は、枠の `nightSunnyConfirmed: true` と根拠があり、時刻が18または00の場合のみ晴に変換します。

## 日付と出力

ゲーム日は06時開始です。observedDate=2026-09-09、startSlot=06なら、5枠は9/9 06・12・18、9/10 00・06です。最後の枠は次ゲーム日の予報として保持します。

startSlot=00なら、その00時はobservedDateの翌暦日です。既存APIは開始枠の暦日をdateに使うため、APIのdateはobservedDate+1になります。返却するtimelineに各枠の暦日時とゲーム日を示します。

戻り値は `status`, `issues`, `timeline`, `payload`。要確認の場合payloadはnullです。登録可能候補のpayloadはaction/date/startSlot/slots/weeks/memoのみで、weeksは常に空オブジェクトです。postKeyは含めません。出典・根拠などをmemoに保持し、APIの1000文字制限を超える場合は切り捨てず要確認とします。

## 実行・接続先

```powershell
. ./tools/weather-candidate.ps1
$candidate = Get-Content -Raw -Encoding UTF8 ./candidate.json | ConvertFrom-Json
$result = ConvertTo-WeatherReportDryRun $candidate
$result | ConvertTo-Json -Depth 10
```

テスト（このプロセスだけ実行ポリシーを指定し、永続設定は変更しません）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-candidate.ps1
```

収集側は `weather-discovery.ps1` から上記共通候補に接続します。アカウント名は変換条件に使いません。「登録可能候補」は送信・登録・公開済みを意味しません。

## pending送信接続（明示指定のみ）

`weather-submit.ps1` は既存の `apps-script/weather-api.gs` の `submit` を呼ぶ接続です。APIは投稿キーを検証し、行を `pending` で保存します。`action: pending` は管理用の一覧取得であり、登録には使いません。API・保存先・承認フローは変更しません。

- `ConvertTo-WeatherPendingPayload -Candidate $candidate` は通信しません。confirmedな `discovery` から出典を再構成し、既存 `ConvertTo-SectionedWeatherReportDryRun` を再実行します。時間別が `ready`、dry-runが「登録可能候補」、`issues` が0件、payloadが存在する場合だけ返します。それ以外は例外で拒否します。外から渡したdry-run結果は信用しません。
- payloadは `action/date/startSlot/slots/weeks/memo` だけです。`weeks` は空、現在・週間の値は送信しません。両セクションの `needsReview` / `missing` は時間別を妨げません。出典URL・投稿ID（`sourceId`）・投稿日時・時間別の根拠は既存memoを再利用し、本文の曖昧さ、時間別未解決0件、現在・週間が対象外である旨を追記します。時間別の未解決事項があれば送信自体を拒否し、現在・週間の未解決事項と全取得履歴はローカル候補に残します。memoは1000文字超過で拒否し、自動切り捨てしません。
- `Invoke-WeatherPendingSubmission` は既定で `prepared` / `sent: false` とキーなしpayloadを返します。`-Send`、明示したHTTPSの `-ApiUrl`、SecureStringの `-PostKey` がそろった場合だけUTF-8 JSONをPOSTします。キーは生成・自動取得せず、候補内の `postKey` も使いません。キーは送信本文だけへ一時的に追加し、返却payloadやログへ出しません。URLの資格情報・クエリ・フラグメントは禁止です。候補のURLやmemoにも秘密を入れないでください。
- `ok: true`・`status: pending`・空でない `id` の応答だけを成功とします。失敗時は例外で停止し、通信例外やサーバーの生エラーは出力しません。タイムアウト等は登録済みの可能性があるため、再送前に既存管理画面で確認します。自動再送・重複送信防止・自動承認・公開は行いません。

次回、実際に1件だけpending登録テストする場合：明示的な実送信の許可後、通常の探索・直接確認で作った1件の `$candidate` を使い、以下を順に実行します（例の候補を本番へ送らない）。PowerShellの実行制限がある環境では `powershell -NoProfile -ExecutionPolicy Bypass` のプロセス内で実行します。

```powershell
. ./tools/weather-submit.ps1
$preview = Invoke-WeatherPendingSubmission -Candidate $candidate
$preview.payload | ConvertTo-Json -Depth 10
# 日付・5枠・出典・memoを確認してから、既存APIのURLと投稿キーを入力する。
$weatherApiUrl = Read-Host '既存weather API URL'
$weatherPostKey = Read-Host '既存の投稿キー' -AsSecureString
try {
    $receipt = Invoke-WeatherPendingSubmission -Candidate $candidate -Send -ApiUrl $weatherApiUrl -PostKey $weatherPostKey
    $receipt  # pending / sent / idのみ
} finally {
    $weatherPostKey.Dispose()
    $weatherPostKey = $null
}
```

返却IDの1件が既存管理画面でpendingに存在することを確認し、承認しないで終了します。今回の実装検証ではこの実送信手順は実行せず、次のモックテストだけを実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-submit.ps1
```

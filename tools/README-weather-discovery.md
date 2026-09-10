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

後段候補は `discovery` に全履歴を保持します。各セクションを省略すると `missing`。画像理解や本文の曖昧さ・矛盾の分類はAI側に残し、既存の時間別安全検証を通します。現在天気と週間天気はAPIへ変換しません。既存dry-runの返却値は `discovery` を含まないため、監査用には `$candidate` と `$result` を一緒に扱ってください。

## テストと次の実機確認

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-discovery.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./tools/test-weather-candidate.ps1
```

テストは合成データのみ。次の実機確認ではアカウント名・既知URLを使わず複数の公開検索を行い、得たURLと探索元をメモリ内でこの形式へ渡します。重複排除後にMCPで直接確認し、成功・失敗を記録。画像から抽出した3セクションを接続し、時間別dry-runの結果まで照合します。登録・API送信は含みません。

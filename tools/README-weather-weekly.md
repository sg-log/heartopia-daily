# Heartopia 週間天気自動化

既存の当日天気capture artifactを再利用し、追加API課金なしで週間予報をpendingまで登録する経路です。公開反映は既存の管理画面から人間が承認します。

## 実コードから確認した既存仕様

- データ構造は `week1` から `week7` までを持つ。
- `week1` は基準日の翌日、以後1日ずつ連続する。
- 週間予報は当日天気と同じ weather report 行の `weeks` に保存される。
- pending の既存承認UIは時間別5枠も含むため、週間だけの独立行は作らない。
- 既存の手動スクショ解析は、上側画像から `week1`〜`week5` を読み、追加の下側画像がある場合に `week6`〜`week7` を読む。下側画像が無い場合は `week6`〜`week7` を未読取の空欄として扱う。

このため週間pendingは、同じ `baseDate` の **承認済み当日天気5枠をそのまま継承**し、画像で実際に確認できた連続5〜7日分だけを `week1` から順に登録します。画像に出ていない後続日は空欄のままです。同日approvedがまだ無い場合は停止し、時間別天気を推測で補完しません。

## 自動化フロー

1. 既存 `[weather-capture-request]` で公開Web/SNSから証拠artifactを取得する。
2. Workがartifact v3の期限付き `reviewUrl` を直接視認する。
3. 日付の根拠画像と週間予報画像を、必要なら複数枚にまたがって確認する。
4. 基準日が画像から確定し、翌日から連続する週間予報が5〜7日分high confidenceで確認できた時だけ `[weather-weekly-review-result]` Issueを作る。
5. `Weather weekly review automation` が、Issue作成者、artifact run/id/name、選択した全raw mediaのMIME/SHA-256/byte size、private review保存SHA、期限、日付連続性、天気allowlistを再検証する。
6. Apps Scriptのprivate `approved` APIから同じ基準日の承認済み5枠を取得する。
7. 承認済み5枠 + 画像で確認できた週間5〜7日 + 証拠情報を既存 `submit` APIへ送りpending登録する。未表示の後続日は空欄にする。
8. 保存後にprivate `pending` APIで5枠・週間・sourceUrlを再照合する。
9. 成功Issueを既存 `heartopia-weather-pending-v1` 形式で閉じる。既存Discord通知が管理画面の承認リンクを通知する。
10. 人間が既存pending画面で、保存済み証拠画像・元画像群・元投稿・週間内容を確認して公開承認する。

## 証拠画像の扱い

週間判読に使ったraw mediaはすべてartifact内のSHA-256とprivate review保存SHAを照合します。Apps Scriptの既存pending証拠保存は1枚対応のため、`weekly-forecast` と指定した画像のうち先頭1枚を保存済み証拠として登録します。それ以外のレビュー済み画像も `sourceImageUrls` として既存管理UIの「元画像」に表示され、元投稿からも確認できます。

当日天気の既存1枚運用には変更を加えません。

## Workが返すレビューJSON

Issueタイトルは `[weather-weekly-review-result]`、本文は `<!-- heartopia-weather-weekly-review-v1 -->` の直後にJSONコードフェンスを1つだけ置きます。

```json
{
  "schemaVersion": 1,
  "responseType": "weather-weekly-review",
  "artifact": {
    "runId": "34870529944",
    "id": "10358184684",
    "name": "weather-x-embed-evidence-34870529944"
  },
  "selectedReviewImages": [
    {
      "role": "base-date",
      "file": "raw-media-0.jpg",
      "mimeType": "image/jpeg",
      "captureSha256": "64文字のsha256",
      "reviewStoredSha256": "captureSha256と同一",
      "reviewUrl": "artifact v3に記録された期限付きURL",
      "expiresAt": "2099-09-16T12:00:00.000Z"
    },
    {
      "role": "weekly-forecast",
      "file": "raw-media-1.jpg",
      "mimeType": "image/jpeg",
      "captureSha256": "別画像の64文字sha256",
      "reviewStoredSha256": "captureSha256と同一",
      "reviewUrl": "artifact v3に記録された期限付きURL",
      "expiresAt": "2099-09-16T12:00:00.000Z"
    }
  ],
  "interpretation": {
    "ready": true,
    "baseDate": "2026-09-16",
    "baseDateDescription": "日付画像で2026/09/16を確認",
    "days": [
      {"date":"2026-09-17","weather":["晴"],"visible":true,"confidence":"high","description":"週間画像で晴アイコンを確認"},
      {"date":"2026-09-18","weather":["雨"],"visible":true,"confidence":"high","description":"週間画像で雨アイコンを確認"},
      {"date":"2026-09-19","weather":["晴"],"visible":true,"confidence":"high","description":"週間画像で晴アイコンを確認"},
      {"date":"2026-09-20","weather":["虹"],"visible":true,"confidence":"high","description":"週間画像で虹アイコンを確認"},
      {"date":"2026-09-21","weather":["晴"],"visible":true,"confidence":"high","description":"週間画像で晴アイコンを確認"}
    ],
    "confidence": "high",
    "summary": "画像内で確認できる翌日から5日分を判読。",
    "unresolved": []
  }
}
```

## 推測禁止ルール

- 基準日は画像内の明示的な日付根拠から確定する。投稿日時だけから基準日を決めない。
- 曜日だけを見て根拠のない日付を作らない。`baseDate` と連続日として機械検証できる日だけ登録する。
- 画像で確認できた週間予報は最低5日必要。6日目・7日目が表示されていなければ空欄でよい。
- 複数画像にまたがる場合は、それぞれをreview URLで直接確認し、すべてartifact SHAに束縛する。
- 見えている日のうち1日でも欠け、低確信、未知アイコンならreadyにしない。
- 週間画像から時間別5枠を推測しない。承認済み同日データだけを継承する。
- private review URLが期限切れなら、その画像を使ったレビューIssueは受理しない。

## テスト

```bash
node --test tools/test-weather-weekly.mjs
```

# Heartopia 週間天気自動化

既存の当日天気capture artifactを再利用し、追加API課金なしで週間予報をpendingまで登録する経路です。公開反映は既存の管理画面から人間が承認します。

## 既存仕様として固定したもの

- 公開UIは `week1` から `week7` の7日分を表示する。
- `week1` は基準日の翌日、`week7` は基準日の7日後。
- 週間予報は当日天気と同じ weather report 行の `weeks` に保存される。
- pending の既存承認UIは時間別5枠を必須にしている。

このため週間pendingは、同じ `baseDate` の **承認済み当日天気5枠をそのまま継承**し、レビュー画像から確定した `week1..week7` だけを差し替えて登録します。同日approvedがまだ無い場合は停止し、時間別天気を推測で補完しません。

## 自動化フロー

1. 既存 `[weather-capture-request]` で公開Web/SNSから証拠artifactを取得する。
2. Workがartifact v3の期限付き `reviewUrl` を直接視認する。
3. 7日すべてが1枚の選択画像内で確認できた時だけ `[weather-weekly-review-result]` Issueを作る。
4. `Weather weekly review automation` が、Issue作成者、artifact run/id/name、raw mediaのMIME/SHA-256/byte size、private review保存SHA、7日連続の日付、全日high、天気allowlistを再検証する。
5. Apps Scriptのprivate `approved` APIから同じ基準日の承認済み5枠を取得する。
6. 承認済み5枠 + レビュー済み週間7日 + 証拠画像を既存 `submit` APIへ送りpending登録する。
7. 保存後にprivate `pending` APIで5枠・7日・sourceUrlを再照合する。
8. 成功Issueを既存 `heartopia-weather-pending-v1` 形式で閉じる。既存Discord通知が管理画面の承認リンクを通知する。
9. 人間が既存pending画面で確認し公開承認する。

## Workが返すレビューJSON

Issueタイトルは `[weather-weekly-review-result]`、本文は `<!-- heartopia-weather-weekly-review-v1 -->` の直後にJSONコードフェンスを1つだけ置きます。

```json
{
  "schemaVersion": 1,
  "responseType": "weather-weekly-review",
  "artifact": {
    "runId": "123456789",
    "id": "987654321",
    "name": "heartopia-weather-evidence-123456789"
  },
  "selectedReviewImage": {
    "file": "raw-media-0.jpg",
    "mimeType": "image/jpeg",
    "captureSha256": "64文字のsha256",
    "reviewStoredSha256": "captureSha256と同一",
    "reviewUrl": "artifact v3に記録された期限付きURL",
    "expiresAt": "2026-09-16T12:00:00.000Z"
  },
  "interpretation": {
    "ready": true,
    "baseDate": "2026-09-16",
    "days": [
      {"date":"2026-09-17","weather":["晴"],"visible":true,"confidence":"high","description":"画像で晴アイコンを確認"},
      {"date":"2026-09-18","weather":["雨"],"visible":true,"confidence":"high","description":"画像で雨アイコンを確認"},
      {"date":"2026-09-19","weather":["晴"],"visible":true,"confidence":"high","description":"画像で晴アイコンを確認"},
      {"date":"2026-09-20","weather":["虹"],"visible":true,"confidence":"high","description":"画像で虹アイコンを確認"},
      {"date":"2026-09-21","weather":["晴"],"visible":true,"confidence":"high","description":"画像で晴アイコンを確認"},
      {"date":"2026-09-22","weather":["流星群"],"visible":true,"confidence":"high","description":"画像で流星群アイコンを確認"},
      {"date":"2026-09-23","weather":["晴"],"visible":true,"confidence":"high","description":"画像で晴アイコンを確認"}
    ],
    "confidence": "high",
    "summary": "翌日から7日後まで全枠を画像で確認。",
    "unresolved": []
  }
}
```

## 推測禁止ルール

- 曜日だけを見て日付へ変換しない。7件すべてに明示的な `date` が必要。
- 7日中1日でも画像外、欠け、低確信、未知アイコンなら `ready` にしない。
- 週間画像から時間別5枠を推測しない。承認済み同日データだけを継承する。
- private review URLが期限切れなら、その画像ではレビューIssueを作らない。
- 現在のv1は **1枚のraw media内で7日すべてを確認できる場合のみ** 自動pending化する。複数画像をまたぐ場合は自動登録せず停止する。

## テスト

```bash
node --test tools/test-weather-weekly.mjs
```

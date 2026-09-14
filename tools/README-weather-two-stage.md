# Weather evidence two-stage handoff

## Stage 1: capture only

`weather-cloud-x-embed-evidence.yml` または `weather-cloud-url-evidence.yml` に候補URLを渡す。Actionsは元URLを一度だけ取得し、`evidence.jpg`、`capture.json`、`discovery-candidate.json` をimmutable artifactへ保存する。この段階では画像判読、candidate生成、pending送信を行わない。

## Stage 2: Work review

Workはartifact内の `evidence.jpg` そのものを見て、次のJSONをUTF-8のBase64にし、`weather-cloud-reviewed-evidence.yml` の `review_payload_base64` に渡す。

```json
{
  "schemaVersion": 1,
  "artifact": {
    "runId": "34794384921",
    "id": "10328214917",
    "name": "weather-x-embed-evidence-34794384921"
  },
  "evidenceSha256": "438bdd850ec5831c5373f29c7248dc3999ea17f2c049ce539550974fe625d1c3",
  "interpretation": {
    "ready": true,
    "observedDate": "2026-09-11",
    "startSlot": "06",
    "slots": [
      { "slot": "slot0", "visible": true, "weather": ["晴"], "confidence": "high", "description": "06時の晴れを確認" },
      { "slot": "slot1", "visible": true, "weather": ["雨"], "confidence": "high", "description": "12時の雨を確認" },
      { "slot": "slot2", "visible": true, "weather": ["晴"], "confidence": "high", "description": "18時の晴れを確認" },
      { "slot": "slot3", "visible": true, "weather": ["晴"], "confidence": "high", "description": "00時の晴れを確認" },
      { "slot": "slot4", "visible": true, "weather": ["晴"], "confidence": "high", "description": "翌06時の晴れを確認" }
    ],
    "confidence": "high",
    "summary": "日付、開始時刻、時間別5枠を画像で確認",
    "unresolved": []
  }
}
```

天気値は既存candidateの正規値（`晴`、`雨`、`流星群`、`虹`、`猛暑`、`雪`、`桜`、`月`）を使う。複数天気は同じ `weather` 配列に入れる。週間予報フィールドは受け付けない。

後段はGitHub APIでartifact ID・run ID・名前の組を確認し、そのartifactをID指定で取得する。`evidence.jpg` の実SHA-256がWork申告値と `capture.json` の値の両方に一致した場合だけ、既存candidate検証と `pending-preview.json` 作成へ進む。`submit_pending` の既定値は `false` で、previewは `sent: false` のまま送信しない。実地テスト等で明示的に `true` にした場合だけ、最終ステップへ送信用secretを渡し、既存の重複確認・pending登録・保存画像再取得・SHA再検証を行う。承認・公開処理には接続しない。

## Work Issue connection

Issue連携は `.github/workflows/weather-issue-automation.yml` が `opened` のみを処理する。リポジトリ、作成者、イベント送信者がすべて `sg-log`、author associationが `OWNER`、Issueがopenで、専用タイトルとraw JSON本文が厳密一致した場合だけ次のjobへ進む。Issue本文をコマンドや式として評価しない。scheduleは設定しない。

取得依頼Issueのタイトルは `[weather-capture-request]`。本文は次のraw JSONだけにする。

```json
{"schemaVersion":1,"requestType":"weather-evidence-capture","adapter":"x-official-embed","sourceUrl":"https://x.com/example/status/123"}
```

`adapter` は `x-official-embed` または `direct-url`。成功すると、同じIssueへ `heartopia-weather-artifact-v1` マーカー付きJSONコメントで `artifact.runId`、`artifact.id`、`artifact.name`、`evidenceSha256` を返す。

判読結果Issueのタイトルは `[weather-review-result]`。本文は「Stage 2: Work review」のJSONだけにする。認証とJSON検証が終わったjobの後にだけ送信secretを渡す。exact artifact identity、実画像SHA、candidate dry-runがすべて通った場合だけ既存submitへ進み、結果を `heartopia-weather-pending-v1` マーカー付きJSONコメントで返す。完全一致の既存pendingは `duplicate: true` として返し、新規登録しない。

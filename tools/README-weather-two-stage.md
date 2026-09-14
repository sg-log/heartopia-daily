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

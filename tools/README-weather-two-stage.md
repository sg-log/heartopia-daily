# Weather evidence two-stage handoff

## Stage 1: capture only

`weather-cloud-x-embed-evidence.yml` は、検証済みのX投稿URLをofficial embed経路で開く。embed DOMから元投稿ですでに公開されている `https://pbs.twimg.com/...` の投稿media URLだけを収集し、そのURLの画像バイト列をcapture時にダウンロードする。

各画像は `raw-media-0.jpg` などの名前でartifactへ保存し、`capture.json` の `rawMedia` に次を記録する。

- `url`: capture時にembedから得た公開media URL
- `file`: artifact内のraw mediaファイル名
- `mimeType`: capture時に検証したJPEGまたはPNG MIME type
- `byteSize`: capture時のバイト数
- `sha256`: GitHub Actionsがcapture時に計算したSHA-256

従来の `evidence.jpg` とそのSHAも互換性のため残す。X media URLがない、raw mediaを取得できない、画像形式・サイズ検証に失敗した場合、X Stage 1は失敗しartifact返却コメントを作らない。Stage 1ではcandidate生成やpending送信を行わない。

取得依頼Issueは `[weather-capture-request]`、本文はraw JSONだけとする。

```json
{"schemaVersion":1,"requestType":"weather-evidence-capture","adapter":"x-official-embed","sourceUrl":"https://x.com/i/status/123"}
```

成功時の `heartopia-weather-artifact-v2` コメントにはexact artifact識別子、従来画像SHA、各raw mediaのURL・ファイル名・MIME type・capture時SHAを返す。画像自体をPagesやrepositoryへ新規公開しない。

## Stage 2: public media URL visual review

Workはartifact ZIPを開かず、Stage 1コメントの `media[].url` を直接開いて視認する。X投稿ページを再取得して判読しない。判読不能または利用可能なmedia URLがない場合、review Issueを作らない。

review Issueは `[weather-review-result]`、本文はschemaVersion 2のraw JSONだけとする。

```json
{
  "schemaVersion": 2,
  "artifact": {
    "runId": "123456789",
    "id": "987654321",
    "name": "weather-x-embed-evidence-123456789"
  },
  "selectedMedia": {
    "url": "https://pbs.twimg.com/media/example?format=jpg&name=small",
    "file": "raw-media-0.jpg",
    "mimeType": "image/jpeg",
    "captureSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "interpretation": {
    "ready": true,
    "observedDate": "2026-09-11",
    "startSlot": "06",
    "slots": [
      { "slot": "slot0", "visible": true, "weather": ["晴"], "confidence": "high", "description": "06時の晴れを視認" },
      { "slot": "slot1", "visible": true, "weather": ["雨"], "confidence": "high", "description": "12時の雨を視認" },
      { "slot": "slot2", "visible": true, "weather": ["晴"], "confidence": "high", "description": "18時の晴れを視認" },
      { "slot": "slot3", "visible": true, "weather": ["晴"], "confidence": "high", "description": "00時の晴れを視認" },
      { "slot": "slot4", "visible": true, "weather": ["晴"], "confidence": "high", "description": "翌06時の晴れを視認" }
    ],
    "confidence": "high",
    "summary": "公開media URLで日付、開始時刻、5枠を視認",
    "unresolved": []
  }
}
```

`captureSha256` はWorkが計算または検証した値ではなく、Stage 1でActionsが返した値を選択mediaと一緒に引き継ぐものとする。

Stage 2は次をすべて満たす場合だけ既存candidate検証とpending送信へ進む。

1. Issue作成者、title、JSON、exact artifact識別子、selected mediaを厳格検証する。
2. exact artifactを取得し、selected mediaのURL・ファイル名・MIME type・capture SHAが `capture.json` と完全一致することを確認する。
3. artifact内raw mediaを読み、実SHA・サイズ・MIME typeがcapture metadataと一致することを確認する。
4. selected media URLをStage 2で再取得し、SHA・サイズ・MIME typeがartifact内raw mediaと一致することを確認する。
5. candidate検証を通過した場合だけsubmit処理へ進む。

Stage 2の再取得画像は一致検証専用であり、candidate、pending preview、pending添付には使わない。pendingへ渡すのはcapture時artifact内のraw mediaそのものとする。不一致、media URLなし、判読結果がreadyでない場合は送信しない。週間予報と自動承認は扱わず、scheduleも設定しない。

## 保証範囲

厳密に照合するのは、capture時artifact raw mediaのSHA、Stage 2再取得SHA、pendingへ渡すartifact raw mediaである。SHA不一致ではpending登録しない。

Workについて確認するのは「capture時に取得されたmedia URLを直接視認した」という運用上の事実だけである。公開URLは不変・content-addressedではないため、Workのブラウザが表示した実バイト列のSHAや、Work表示画像とartifact画像の暗号学的同一性は保証しない。review結果とログでは、SHA検証主体をGitHub Actionsとして記録する。

従来のschemaVersion 1 artifact画像reviewは既存artifact互換のため残す。

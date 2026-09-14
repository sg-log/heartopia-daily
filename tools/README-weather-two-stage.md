# Weather evidence two-stage handoff

## Stage 1: capture and private review publication

`weather-cloud-x-embed-evidence.yml` は、検証済みX投稿URLをofficial embed経路で開き、元投稿で公開済みの `pbs.twimg.com` 投稿mediaをcaptureする。各画像を `raw-media-0.jpg` などとしてartifactへ保存し、URL、ファイル名、MIME type、サイズ、Actionsが計算したSHA-256を `capture.json.rawMedia` に記録する。

Issue連携では、取得依頼Issueのrepository、作成者、sender、owner association、title、raw JSONを検証したjobが成功した後だけ、別jobへ `WEATHER_POST_KEY` を渡す。このjobはexact artifactを取得し、artifact内raw mediaの実SHA・MIME・サイズを再検証してから、既存Heartopia Weather Apps Scriptへ1画像ずつPOSTする。Apps Script側も認証、Base64、MIME、サイズ、画像signature、capture SHAを検証し、同じバイト列だけを既存private Drive evidence folderへ期限付きreview画像として保存する。

取得依頼Issueは `[weather-capture-request]`、本文はraw JSONだけとする。

```json
{"schemaVersion":1,"requestType":"weather-evidence-capture","adapter":"x-official-embed","sourceUrl":"https://x.com/i/status/123"}
```

成功時の `heartopia-weather-artifact-v3` コメントにはexact artifact識別子と `reviewImages` を返す。各要素はartifactファイル名、MIME、サイズ、capture SHA、review Drive保存SHA、期限付きreview URL、有効期限を持つ。元のpbs URL、Drive fileId、POST_KEY、ADMIN_KEYは返さない。

## Expiring review image URL

Apps Scriptは2個のUUIDと時刻をPOST_KEYでHMAC-SHA256署名し、43文字のbase64url tokenを生成する。Script Propertiesにはraw tokenではなくtokenのSHA-256をkeyとして、Drive fileId、MIME、サイズ、SHA、有効期限だけを保存する。有効期限は発行から15分。

review URLは既存deployment URLの次の形式である。

```text
https://script.google.com/macros/s/.../exec?reviewToken=<43-character-token>
```

`doGet`は `reviewToken` 以外のquery parameterを拒否し、token hashからサーバー側の保存情報だけを解決する。クライアント指定のpathやfileIdは使わない。Driveファイルがprivate、専用folder所属、未削除、期限内で、保存済みSHA・サイズと実バイトが一致した場合だけ、画像をdata URLとしてHTMLへ埋め込む。Drive共有設定は変更しない。期限切れ・不正・不一致は同じunavailable HTMLを返し、token propertyを削除して一時ファイルをゴミ箱へ移す。新規発行時にも期限切れレコードを清掃する。

Workはartifact ZIPやpbs URLを開かず、Issueコメントのreview URLだけをブラウザで開いて視認する。Work自身が画像SHAを計算または検証したとは扱わない。

## Stage 2: Work review

判読結果Issueは `[weather-review-result]`、本文はschemaVersion 3のraw JSONだけとする。

```json
{
  "schemaVersion": 3,
  "artifact": {
    "runId": "123456789",
    "id": "987654321",
    "name": "weather-x-embed-evidence-123456789"
  },
  "selectedReviewImage": {
    "file": "raw-media-0.jpg",
    "mimeType": "image/jpeg",
    "captureSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "reviewStoredSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "reviewUrl": "https://script.google.com/macros/s/example/exec?reviewToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "expiresAt": "2026-09-15T12:34:56.789Z"
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
    "summary": "期限付きreview URLで日付、開始時刻、5枠を視認",
    "unresolved": []
  }
}
```

`captureSha256` と `reviewStoredSha256` はWorkが計算した値ではなく、Stage 1でActionsとApps Scriptが返した値を選択画像と一緒に引き継ぐ。Issue automationはschemaVersion 3だけを本番review経路として受け付ける。旧schemaVersion 1/2は手動workflowとの互換性だけを残す。

Stage 2はexact artifactを取得し、選択ファイル・MIME・capture SHAが `capture.json.rawMedia` と一致すること、artifact内raw mediaの実SHA・MIME・サイズが一致すること、review Drive保存SHAが同じであることを検証する。その後だけ既存candidate検証へ進む。判読不能、missing media、SHA不一致、candidate未readyではpending送信しない。

candidate、pending preview、pending添付に使う画像はcapture時artifact内raw mediaそのもの。review Drive画像は表示専用で、pending添付には使わない。review Drive画像とpending元画像は、それぞれの保存・Stage2検証時に同一capture SHAへ結び付ける。

週間予報、自動承認、scheduleは扱わない。

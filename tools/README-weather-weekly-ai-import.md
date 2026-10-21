# Heartopia Daily 週間天気「GPT担当」運用

状態：2026-10-21 開発ブランチ `feat/weekly-ai-import-20261020` / Draft PR #265。**main反映・Apps Scriptデプロイ前。**

## ユーザーの操作（公開後）

1. ゲーム内「週間天気」のスクショを撮る。画面をスクロールする必要があれば複数枚送る。
2. ChatGPTの「ハートピアサイト」プロジェクトで「週間天気更新して」とスクショを送る。
3. GPTが7日分の判読結果を提示し、問題がなければ **取り込みリンク**を返す。
4. リンクでHeartopia Daily管理画面を開き、管理キーでログイン（必要な場合のみ）。
5. 「既存データと照合」で公開中の週間予報との差分を確認し、「確認して週間天気を保存」を押す。
6. サーバーが保存された値を再取得できたことと、公開画面の表示を確認して完了。

自動保存はしない。ユーザー自身による最終確認が必須。リンクに管理キーや認証情報を含めない。

## 判読ルール

- ゲーム内は朝6時に日付切替。画像だけで撮影日がわからない場合はユーザーに**基準日だけ**確認する。
- 週間表示は基準日の翌日〜7日後、`week1`〜`week7`。今のコードは `WEATHER_WEEK_START_OFFSET=1`。
- 天気は `晴`、`雨`、`流星群`、`虹`、`猛暑`、`雪`、`桜` のいずれか。
- 夜の「晴れ（月のマーク）」と「流星群（月＋流れ星）」を混同しない。
- **見えていない日付・読めないアイコンは推測しない。** 更新JSONに載せた日だけ変更し、欠けた日は以前の予報を保持する。
- 今日の時間別天気 `slot0..slot4` を更新しない。TH.GL由来の当日天気データ、同サービスの履歴は再公開しない。
- 更新前に基準日と日付→曜日の対応を確認し、日付をまたぐ複数枚は同じゲーム内予報に属することを確認する。

## GPT出力データ

```json
{
  "schemaVersion": 1,
  "source": "game-screenshot",
  "baseDate": "2026-10-21",
  "days": [
    {"date": "2026-10-22", "weather": "流星群"},
    {"date": "2026-10-23", "weather": "虹"},
    {"date": "2026-10-24", "weather": "晴"},
    {"date": "2026-10-25", "weather": "雨"},
    {"date": "2026-10-26", "weather": "晴"},
    {"date": "2026-10-27", "weather": "晴"},
    {"date": "2026-10-28", "weather": "晴"}
  ]
}
```

上は2026-10-21にユーザーが渡した実ゲームUIスクショに基づくテストケース。新しい依頼時には前回のデータを流用せず新しい画像を読み直す。

### ワンクリック取り込みリンク

公開後に利用可能。下記の `payload` を正しく検証してからURL fragmentへ設定する。

```js
const url = new URL("https://sg-log.github.io/heartopia-daily/");
url.search = "?admin=1";
url.hash = "weekly-import=" + encodeURIComponent(JSON.stringify(payload));
const importUrl = url.href;
```

`payload` には上の形式のJSONオブジェクトだけを入れる。リンク中のデータはURLフラグメントでWebサーバーへ送信されず、管理画面で読み取り、**ユーザーが保存ボタンを押すまでAPI書き込みは起きない**。

## 実装箇所

- `assets/weekly-ai-import.js`：厳格な日付と天気の検証、URL fragmentの解析、読み取りのみの差分表示、保存前の承認。
- `index.html`：管理UIの取り込みパネル、1クリック入力、予報表示、日付が進んでも残る週間データの統合。
- `apps-script/weather-api.gs`：独立シート `weekly_forecasts`、認証必須の `saveWeeklyForecast`、公開用 `getWeeklyForecasts`。
- 既存の `weather_reports` の日次5枠には書かない。競合時は保存を拒否して再照合させる。
- `tools/test-weather-weekly-ai-import.mjs`：実スクショケース、境界日付、不正データ、保存分離、競合、リンク入力、公開読取を検証する。

## テスト・公開前チェック

- `npm run test:weather-weekly-ai` または `node --test tools/test-weather-weekly-ai-import.mjs`
- PRの `Weather weekly automation CI` と既存の他CIが成功すること。
- 実ブラウザ（PC/スマホ）で「リンク→管理ログイン→差分→保存→リロード後表示」を確認。
- 既存の当日TH.GL表示、ギフトコード、管理画面、日付切替に副作用がないこと。
- Apps Scriptを同じデプロイへpush／デプロイ更新してからWeb側のmainを更新（順序の検証を含む）。
- **mainへのmerge、公開GitHub Pagesへの反映、Apps Scriptデプロイは必ずユーザーの明示確認後。**
- 保存後の実データ確認なしに「反映済み」と報告しない。

最新仕様の正本：Notion「Heartopia Daily｜ゴール・現行仕様・設計図・注意点【正本】」。現行のGitHub実コードと異なる場合はコードを確認して判断する。

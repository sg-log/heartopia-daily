# Heartopia Daily ギフトコード自動取得

## 目的

PCがOFFでも、公式Discordから自分のDiscordへ転送されたギフトコード投稿を約5分間隔で確認し、既存の `gift_codes` シートへ自動登録します。

現在の流れ:

```text
Heartopia公式Discord
  ↓ Discordのチャンネルフォロー
自分のDiscord「受信用」チャンネル
  ↓
Apps Scriptの5分トリガー
  ↓ workflow_dispatch
GitHub Actions
  ↓ Discord REST API
Apps Scriptの認証済み取込API
  ↓ 固定フォーマットを解析
gift_codes
  ↓
Heartopia Daily
```

Apps Script から Discord Bot API を直接読む構成は使いません。Apps Script は時刻制御と GitHub Actions の起動を担当し、Discord API への通信は GitHub Actions が担当します。

## 安全方針

- `Rewards:` と `Gift Code:` を両方確認できる投稿だけを候補として Apps Script へ送ります。
- DiscordのWebhook投稿だけを登録対象にします。
- 最初に正常解析できた転送Webhook IDを記録し、以後は同じWebhookだけを読みます。
- Gift Codeが複数ある、Rewards形式が崩れているなど曖昧な投稿は自動登録しません。
- 既存の手動データと報酬・期限が矛盾した場合は自動上書きしません。
- `hidden` にしたコードは自動処理で `active` に戻しません。
- ブラウザの「受取済」状態はLocalStorageのため、自動登録・更新では変更されません。
- 初回実行は直近最大100メッセージを確認し、対象候補を静かにバックフィルします。古いコードで通知を大量送信しません。
- 未確認の英語アイテム名は勝手に訳さず、英語のまま保存してメモに `日本語名未確認` を残します。
- Bot Token は GitHub Actions Secret にだけ保存し、Apps Script / Git / HTML には保存しません。
- GitHub Actions から Apps Script への書き込みは既存の `WEATHER_POST_KEY` / `POST_KEY` 認証を再利用します。

## 現在の日本語名辞書

```text
Wishing star       → 願い星
Dye                → 染色剤
Flawless Fluorite  → 無垢な蛍石
```

追加の正式名称は Apps Script の Script Properties に `GIFT_REWARD_NAME_MAP` をJSONで設定すると上書き・追加できます。

例:

```json
{"New English Item":"日本語正式名称"}
```

## Discord Botの準備

1. Discord Developer Portalで自分用App / Botを1つ作成します。
2. Bot設定で **Message Content Intent** をONにします。
3. 自分のDiscordサーバーへBotを追加します。
4. 「受信用」チャンネルをBotが閲覧でき、メッセージ履歴を読めるようにします。
5. Bot Tokenを取得します。
6. Discordの開発者モードをONにして「受信用」チャンネルのIDをコピーします。

Botに `Send Messages` 権限は不要です。

## 保存場所

### GitHub Actions Secret

必須:

```text
DISCORD_GIFT_BOT_TOKEN = Bot Token
```

既存の以下のSecretも使用します。

```text
WEATHER_POST_KEY
```

### Apps Script Script Properties

必須:

```text
DISCORD_GIFT_CHANNEL_ID = 受信用チャンネルID
GITHUB_ACTIONS_TOKEN = 既存のGitHub Actions起動用Token
POST_KEY = 既存の取込認証キー
```

任意・自動管理:

```text
DISCORD_GIFT_GUILD_ID = サーバーID
DISCORD_GIFT_SOURCE_WEBHOOK_ID = 公式転送Webhook ID
DISCORD_GIFT_LAST_MESSAGE_ID = 最後に確認したDiscordメッセージID
DISCORD_GIFT_REVIEW_WEBHOOK_URL = 要確認通知専用Webhook
GIFT_REWARD_NAME_MAP = 追加の英語名→日本語正式名JSON
```

以前 Apps Script に保存していた `DISCORD_GIFT_BOT_TOKEN` は、この方式では不要です。GitHub Secret の疎通確認後に削除できます。

## 初回セットアップ

Apps Scriptへコードを反映・Webアプリを更新したあと、エディタから次を実行します。

```text
testGiftCodeDiscordConnection
```

この関数は GitHub Actions の `gift-code-discord-poll.yml` を `test` モードで即時起動します。Discordの接続結果そのものは GitHub Actions の実行結果で確認します。

接続テスト成功後:

```text
installGiftCodeScheduler
```

これでApps Scriptが5分ごとにGitHub Actionsを即時dispatchします。GitHub cronは使わないため、PCは不要です。

## 運用確認

状態確認:

```text
getGiftCodeAutomationStatus
```

Discordのフォロー先を作り直して転送Webhookが変わった場合:

```text
resetGiftCodeAutomationSourceWebhook
```

過去メッセージを再バックフィルしたい場合:

```text
resetGiftCodeAutomationCursor
```

次回実行で直近最大100メッセージを再確認します。コード重複は `gift_codes` 側で抑止します。

## 解析対象例

```text
🎁Rewards: Wishing star ×3, Dye ×2, Flawless Fluorite ×1
🔑Gift Code: r8a4k6p5q3m1
⏰Redemption Deadline: 2026年10月1日 0:59
```

保存結果:

```text
code: r8a4k6p5q3m1
reward:
願い星×3
染色剤×2
無垢な蛍石×1
expiresAt: 2026-10-01T00:59
status: active
```

Discordの生メッセージが `<t:UNIX:F>` のタイムスタンプを使っている場合もJSTへ変換します。

## テスト

```bash
npm run test:gift-discord
```

現在のDiscord投稿形式、日本語化、Discord timestamp、未知アイテム、複数コード、曖昧なRewards、通知ループ防止、Snowflake順序、GitHub Actions経由の候補抽出・カーソル更新を回帰テストします。

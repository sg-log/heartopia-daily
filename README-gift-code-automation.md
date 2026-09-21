# Heartopia Daily ギフトコード自動取得

## 目的

PCがOFFでも、公式Discordのフォロー転送を約5分間隔で確認し、公式X（@myheartopia / @Heartopia_JP）もバックアップ確認して、既存の `gift_codes` シートへ自動登録します。

現在の流れ:

```text
Heartopia公式Discord（redeem-code / announcement など）
  ↓ Discordのチャンネルフォロー
自分のDiscord「受信用」チャンネル
  ↓
Apps Scriptの5分トリガー
  ↓ workflow_dispatch
GitHub Actions
  ├─ Discord REST API（毎回）
  └─ 公式Xバックアップ（約15分間隔）
       ├─ @myheartopia
       └─ @Heartopia_JP
  ↓
Apps Scriptの認証済み取込API
  ↓ 安全な形式だけ解析・重複判定
gift_codes
  ↓
Heartopia Daily
```

Apps Script から Discord Bot API を直接読む構成は使いません。Apps Script は時刻制御と GitHub Actions の起動を担当し、Discord / X への公開通信は GitHub Actions が担当します。公式XはDiscordフォロー漏れのバックアップで、取得できない場合でもDiscord側の自動取得は止めません。

## 安全方針

- `Rewards:` + `Gift Code:` 形式に加え、公式announcementで使われる「報酬を1行ずつ列挙 → Gift Code」形式も安全に解析します。
- DiscordはWebhook投稿だけを登録対象にします。
- 複数の公式チャンネルを同じ「受信用」へフォローできるよう、正常解析できた転送Webhook IDを最大8件まで学習します。
- 公式Xは @myheartopia / @Heartopia_JP の投稿だけを対象にし、X公式oEmbedで投稿者を再確認してから候補にします。
- Xの公開取得に失敗した場合はバックアップだけをスキップし、Discord側の処理は継続します。
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
DISCORD_GIFT_SOURCE_WEBHOOK_ID = 最初に学習した公式転送Webhook ID（互換用）
DISCORD_GIFT_SOURCE_WEBHOOK_IDS = 学習済み公式転送Webhook ID一覧（自動管理）
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

Discordのフォロー先を作り直した場合や、学習済み転送Webhookをいったん全部リセットしたい場合:

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

Discordの生メッセージが `<t:UNIX:F>` のタイムスタンプを使っている場合もJSTへ変換します。日本語公式投稿の「報酬／ギフトコード／交換期限」ラベルにも対応し、すでに日本語の報酬名は「日本語名未確認」扱いにしません。

## 受取済バックアップ

公開ページの「受取済」は引き続きブラウザ内にも保存しますが、同時に Apps Script 側の `gift_claim_backups` シートへ匿名バックアップします。

- 初回表示時に既存の `giftCodeClaimed:...` を自動でサーバーへ移行・マージ
- コピー / 受取済トグルのたびにサーバーへ同期
- 端末ごとにランダムな128-bit復元IDを生成
- 復元IDは localStorage と first-party cookie の両方へ保持
- サーバーには復元IDそのものではなく SHA-256 ハッシュだけを保存
- 公開UIの「復元コードをコピー」で、完全なサイトデータ削除後も手動復元可能
- 復元コードは受取済データへの鍵になるため、他人と共有しない

通常のサイト更新・デプロイ・localStorage側の表示不具合では、サーバー側の記録と再マージできます。ブラウザのサイトデータを完全削除した場合は、ユーザーが保存した復元コードが必要です。

## テスト

```bash
npm run test:gift-discord
```

旧redeem-code形式、新announcement形式、日本語ラベル、日本語化、Discord timestamp、未知アイテム、複数コード、曖昧なRewards、複数フォローWebhook、通知ループ防止、Snowflake順序、GitHub Actions経由のDiscord候補抽出・カーソル更新、公式Xバックアップの投稿者検証と取込を回帰テストします。

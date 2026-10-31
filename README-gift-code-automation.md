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

### 公開一覧との照合と個人用の確認待ち

公式Xの確認時（約15分間隔）に HeartopiaGuide と Heartodex の公開中の有効コード欄も取得し、サイトの登録済みコードと照合します。期限切れ欄は候補にしません。外部一覧は発見専用で、一覧に書かれた報酬・期限を自動公開には使いません。

一覧にある公式Xリンクは投稿者とコードの一致を確認し、全文で報酬・期限が読み取れたものだけ既存の登録処理へ渡します。省略された本文や確認できない候補は非公開の `gift_code_reviews` シートへ保存します。Xの期限がない・不正な場合も自動登録しません。明記されたUTC時差は日本時間へ変換します。

確認待ちの通知は、有効コード欄に掲載され、サイトに未登録の候補だけを対象にします。検索で見つけただけの古いX投稿や、期限欄が空でも登録済みのコードは通知しません。GitHub Secret `WEATHER_DC_WEBHOOK_URL`（既存の天気確認用・個人Discord）だけへ、1回の実行につき最大3候補を1通にまとめて送ります。フレンド通知用Webhookへは送らず、未設定時は確認待ちを保存して通知未送信を実行ログに残します。送信成功後の確認応答で配信済みとし、同じ候補を繰り返し通知しません。送信失敗時は次回確認で再試行します。

通知のリンクは Heartopia Daily の管理画面の対象カードへ直接つながります（`?admin=1&giftReview=ID#pendingGiftReviews`）。管理キーはURLに入れません。管理キーで開くと「ギフトコードの承認待ち」にコード、報酬の下書き、期限候補、公式投稿URL、取得本文を表示します。非公式サイトへの移動は不要です。

公開一覧の期限は `deadlineHint` として非公開の下書きに保持し、画面では未確認の候補と明記します。公式情報を確認したチェックと、報酬・期限・公式投稿URLが揃ってから「承認して公開」できます。期限未取得なら管理画面内で補完できます。承認するとサイトへ登録し、フレンドDiscordへ一度だけ通知します。「見送る」は公開・通知しません。

確認待ちの取得・承認・見送りAPIは既存の管理キーによる認証が必須です。公開APIには下書きを返しません。二重承認や、別経路で登録済み・非表示になったコードの上書きを防ぎます。配信済みの確認依頼も、処理するまでは管理画面で確認できます。

通常の登録は引き続き自動です。管理画面の確認待ちは、必要な情報を取得しきれなかった例外だけです。

例外候補の公式X投稿は公開埋め込みを実際に描画してスクリーンショットにし、既存の所有者限定Driveフォルダへ保存します。管理画面に認証済みAPIから表示し、公開サイトやDiscordへ画像を再掲載しません。投稿者・コードの一致を確かめ、画像の形式・サイズ・ハッシュ・保存先・非公開設定も確認します。クライアントから任意のDriveファイルIDは指定できません。

画像は取得できた表示範囲の記録です。「さらに表示」に隠れた期限まで取得できたという意味ではありません。取得失敗時は本文と公式リンクを残して管理画面へ明示し、同じ候補の再試行は最大1日1回に抑えます。新たな有料APIやAIは使いません。

取得処理をmainへ更新したときも、公開一覧の照合を一度実行して既存の確認待ちへ期限候補を補います。通常のDiscord受信確認は従来の5分トリガーで継続します。

取得先の停止や公開一覧の更新遅延もあるため、全投稿の即時発見を保証する仕組みではありません。実行ログに一覧ごとの取得結果・候補数・利用できた取得先数を残します。新たな有料API、AI API、ログイン情報は使いません。

- `Rewards:` + `Gift Code:` 形式、公式announcementの「報酬を1行ずつ列挙 → Gift Code」形式に加え、明示された「ギフトコード内容：」「Rewards」見出しの直下に報酬を列挙する形式を解析します。列挙に不正な行があれば、正常な先頭部分だけを登録しません。
- GitHub側の候補判定もApps Scriptと同じパーサーを使い、日本語・報酬列挙形式を入口で落としません。
- 判定形式の更新時は、受信履歴の直近最大100メッセージを一度だけ再確認します。確認済みIDを巻き戻さず、過去分の回収通知は送りません。既存の非表示・矛盾時の上書き禁止を維持します。
- DiscordはWebhook投稿だけを登録対象にします。
- 複数の公式チャンネルを同じ「受信用」へフォローできるよう、正常解析できた転送Webhook IDを最大8件まで学習します。
- 公式Xは @myheartopia / @Heartopia_JP の投稿だけを対象にし、X公式oEmbedで投稿者を再確認してから候補にします。
- Xの公開取得に失敗した場合はバックアップだけをスキップし、Discord側の処理は継続します。
- Xの投稿発見は公式の公開プロフィールを先に確認し、取得できない場合は公式埋め込みタイムライン、Bing、Yahoo通常検索の順に試します。検索結果の本文では確定せず、公式oEmbedで投稿者を確認します。プロフィールがログイン画面だけの場合や検索結果しか使えない場合は、最新投稿の発見ができているとは扱わず、Actionsの警告と実行サマリーに取得状況を残します。
- oEmbedのギフト本文が省略されている場合は、同じ公式投稿の公開ページを取得します。canonical、投稿URL、投稿者、oEmbed本文との前方一致、本文領域の一致を確認した全文だけを使います。引用・返信・メタ情報は代用せず、全文取得に失敗した投稿は従来どおり保留します。新しい投稿URLやコードをプログラムに固定する運用は不要です。
- 公開HTMLの解析には `parse5` を固定バージョンで使用します。Actionsではロックファイルに従って依存関係を導入し、インストール時の追加スクリプトは実行しません。
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

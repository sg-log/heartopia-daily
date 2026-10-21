# Heartopia Daily | ChatGPTのOKで週間天気をHPへ反映

## ゴール

ゲーム画面のスクショをChatGPTへ送る → ゲーム日付と7日間の天気を判読 → **実際の週間天気を読み込んでここで照合** → 利用者がチャットで「OK」 → ChatGPTがGitHubに書き込み依頼を発行 → GitHub Actionsが**週間専用**Google Apps Scriptへ保存 → 公開API再取得で確認 → ChatGPTが結果報告。

JSONの手作業貼付、管理画面の差分照合、管理画面の保存ボタンは通常不要。従来の管理画面は緊急時用として残す。追加のOpenAI APIや有料APIは使わない。

## 安全な専用ルート

- GitHub workflow .github/workflows/weather-weekly-chat-bridge.yml が、リポジトリ所有者の新規Issue（タイトル Heartopia weekly chat READ または SAVE）のみ受け付ける。
- tools/weekly-chat-bridge.mjs が公開GET getWeeklyForecasts / approved を読み取り、従来のHPと同じ週間表示の継承順で現在値を計算する。
- READ Issueには書き込みがない。生成されたIssueコメントの HEARTOPIA_WEEKLY_CHAT_RESULT_V1 JSON が、見えている現行7日分、同じ基準日の週間専用行の期待値、照合日時を返す。
- SAVE Issueは「チャットでOK」後にだけ作る。30分以上前の読み取り内容なら再読み取りする。保存前に再度現在値を取得して変更があれば中止する。
- SAVEがPOSTするのは action:saveWeeklyForecast だけ。GitHub Actions Secret WEATHER_ADMIN_KEY を使用し、日時別weather_reportsやTH.GL、ギフトコードには書き込まない。
- 保存後に公開APIをGETし直して確認する。verified:true がIssueコメントで確認できるまで「更新済み」と報告しない。

## ChatGPTの運用

1. スクショを読み取り、基準となるゲーム日付（06:00切替）と明日～7日後の天気を日付付きで整理。見えない天気は推測しない。
2. GitHubの接続済みPluginで sg-log/heartopia-daily にREAD Issueを新規作成。
   Title: Heartopia weekly chat READ 2026-10-21
   Bodyの全内容（例）:
   <!-- HEARTOPIA_WEEKLY_CHAT_REQUEST_V1
   {"v":1,"type":"read","baseDate":"2026-10-21"}
   -->
3. READのIssueコメントにある HEARTOPIA_WEEKLY_CHAT_RESULT_V1 のJSONを取得。ok:true / type:readを確認し、daysの現行値とスクショを比較して、ここで変更予定を表示。ChatGPTはこの時点で保存しない。
4. 利用者の明示的な「OK」後にのみSAVE Issueを新規作成。
   Title: Heartopia weekly chat SAVE 2026-10-21
   Bodyの全内容（形式例）:
   <!-- HEARTOPIA_WEEKLY_CHAT_REQUEST_V1
   {"v":1,"type":"save","baseDate":"2026-10-21","readAt":"2026-10-21T10:00:00.000Z","expected":{"week1":[],"week2":[],"week3":[],"week4":[],"week5":[],"week6":[],"week7":[]},"expectedVisible":{"week1":[],"week2":[],"week3":[],"week4":[],"week5":[],"week6":[],"week7":[]},"updates":[{"date":"2026-10-22","weather":"流星群"}]}
   -->
   **重要: expected、expectedVisible、readAtは必ず直近のREAD結果をそのままコピーする。空配列を固定で使わない。**
5. SAVE Issueコメントを読み、ok:true / type:save / verified:trueを確認して初めてユーザーへ成功報告する。コメントがない場合はActions実行中として扱い、保存済みと言わない。
6. stale-comparison、タイムアウト、認証失敗なら勝手に再送せず、再度READから始める。GitHub issueはopenedで処理するので後から編集しても再実行されない。

## 注意事項

- GitHub Issueは公開される。管理キー・POSTキー・Discord Webhookなどを入れない。
- GitHub Issueの作成者がsg-logではない場合、Workflowは実行されない。ユーザー接続を確認し、誰でも書ける設定に変更しない。
- ユーザーのチャットでのOKがない状態でSAVEを発行しない。完全無人更新は現段階では有効にしない。
- 週間専用データ以外を更新しない。既存の天気・ギフトコード・サイト公開表示は維持する。

自動テスト: node --test tools/test-weekly-chat-bridge.mjs

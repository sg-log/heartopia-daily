# チャットからのギフトコード復旧

利用者の通常操作は「公式URLまたは公式告知のスクショを送る → 内容・差分を見る → OK」のみ。
以下のGitHub処理とJSONの作成はAIが担当する。利用者へJSON貼付、管理画面操作、PowerShellを求めない。

## 手順

1. 公式本文または公式告知スクショからコード・報酬・交換期限を読む。不明な項目は推測しない。
2. GitHub専用READを実行し、現在の本番登録内容を取得する。
3. 未登録なら追加内容をチャットに表示する。登録済みは再追加しない。
4. 利用者が具体的な内容を確認して「OK」と明示承認した場合のみSAVEを実行する。
5. SAVE結果のverified:trueを確認する。さらに独立したREADで本番コードを再取得し一致を確認して報告する。

作業開始・自動化実装への承認と、個別コードの登録承認は区別する。
SAVEは比較から30分以内。過ぎた場合は再READして差分を再確認する。
保存後の再取得が失敗した場合は完了扱いにしない。保存済みの可能性があるので、再READしてから追加を判断する。

## リクエスト

リポジトリ所有者が新規作成したIssueだけが対象。タイトル:

`Heartopia gift chat READ CODE`
`Heartopia gift chat SAVE CODE`

本文は tools/gift-code-chat-bridge.mjs の requestBody() で生成する。
READデータ:
`{v:1,type:"read",item:{code,reward,expiresAt,sourceUrl,sourceType}}`
SAVEデータ:
`{v:1,type:"save",item:{code,reward,expiresAt,sourceUrl,sourceType},readAt,confirmed:true}`

expiresAtは日本時間YYYY-MM-DDTHH:mm。sourceTypeはofficial-postまたはofficial-screenshot。
sourceUrlは確認した公式Xの追跡パラメータを除いたURL。official-screenshotでURL不明の場合だけ空欄を許可する。
公式Xの対象アカウントはHeartopia_JPとmyheartopiaのみ。出典を確認したという判断はAIと利用者の承認による。

結果コメントの HEARTOPIA_GIFT_CHAT_RESULT_V1 内JSONを読む。
比較対象はcode・reward・expiresAt・sourceUrl・status。
登録済みコードの修正・非表示解除には使わない。専用GASアクションsaveGiftCodeFromChatはロック内で新規追加だけ行う。
既存の管理画面のsaveGiftCode、週間天気・当日天気の保存アクションは呼ばない。
新規active登録時の既存ギフトコード通知を使う。検証時は本番書込みも通知も行わない。

## 反映

専用workflowとGASの新規アクションが両方反映されてから利用可能。
GitHubだけ反映し、GASが未反映の場合はunknown actionで停止する。既存の上書き可能な保存APIへ代替しない。
GASは現在稼働中の全ファイルを取得・保持し、必要なファイルだけ更新する安全な手順で反映する。
本番登録テストは利用者が個別コードの内容を承認した後に実施する。

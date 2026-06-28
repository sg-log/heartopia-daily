# 天気報告APIの準備

この手順で、Googleスプレッドシートを保存先にした天気報告APIを用意できます。

## 1. スプレッドシートを作る

1. Googleスプレッドシートを新規作成します。
2. シート名を `weather_reports` にします。
3. 1行目へ、次の列名を左から順番に入力します。

```text
id
date
startSlot
slot0
slot1
slot2
slot3
slot4
week1
week2
week3
week4
week5
memo
status
投稿者
createdAt
approvedAt
```

天気枠は複数選択を保つため、セル内にJSON配列として保存されます。

ギフトコード機能を使う場合は、同じスプレッドシート内に `gift_codes` シートも追加し、1行目へ次の列名を左から順番に入力します。

```text
id
code
reward
expiresAt
sourceUrl
memo
status
createdAt
updatedAt
```

`status` は `active` / `expired` / `hidden` を使います。`hidden` は公開ページに表示されません。

お知らせ機能を使う場合は、同じスプレッドシート内に `site_notice` シートも追加し、1行目へ次の列名を左から順番に入力します。

```text
noticeDate
noticeText
updatedAt
```

お知らせは2行目を手動お知らせ、3行目をギフトコード更新時の自動お知らせとして使います。手動お知らせの `noticeText` が入力されている場合は手動お知らせを優先し、空の場合は自動お知らせを表示します。

## 2. Apps Scriptを設定する

1. スプレッドシートの「拡張機能」→「Apps Script」を開きます。
2. 初期コードを削除し、`apps-script/weather-api.gs` の内容を貼り付けます。
3. Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」で、次の2つを設定します。

```text
プロパティ名: POST_KEY
値: 友達へ共有する投稿キー

プロパティ名: ADMIN_KEY
値: 管理者だけが使う長い管理キー
```

`ADMIN_KEY` は公開ページ、README、友達へ共有する文面、Git管理対象ファイルには書かないでください。

## 3. Webアプリとして公開する

1. Apps Script右上の「デプロイ」→「新しいデプロイ」を選びます。
2. 種類は「ウェブアプリ」にします。
3. 実行するユーザーは「自分」、アクセスできるユーザーは運用に合う公開範囲を選びます。GitHub Pagesから利用する場合は、通常「全員」が必要です。
4. デプロイし、初回の権限確認を完了します。
5. 表示された `/exec` で終わるWebアプリURLをコピーします。

コードを変更した場合は「デプロイを管理」から新しいバージョンへ更新してください。

## 4. GitHub Pages側へURLを設定する

`index.html` のJavaScript上部にある定数へ、コピーしたURLを貼り付けます。

```js
const WEATHER_API_URL = "https://script.google.com/macros/s/...../exec";
```

空文字のままでは、公開側に「送信先が未設定です」、管理側に「天気報告APIは未設定です。」と表示され、通信は行いません。

公開側の天気報告は、GitHub PagesからのCORSプリフライトを避けるため、フォーム形式のPOSTを `no-cors` で送信します。ブラウザからレスポンス本文は確認できないため、送信後はスプレッドシートに行が追加されたかを確認してください。

## 5. 動作確認

1. 通常ページの「天気メモ」→「天気を報告」から、`POST_KEY` を使って投稿します。
2. `?admin=1` を付けて管理画面を開きます。
3. 「未承認の天気報告」に `ADMIN_KEY` を入力して一覧を更新します。
4. 承認または却下します。
5. 次のURLをブラウザで開き、承認済み一覧がJSONで返ることを確認します。

```text
WebアプリURL?action=approved
```

未承認一覧の取得、承認、却下、管理保存は、管理画面からPOSTで行います。管理キーはURLではなくリクエスト本文に含めます。

キーをURLに含めるとブラウザ履歴やアクセスログに残る可能性があります。`?adminKey=...` のようなURLは使わないでください。

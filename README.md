# WebRTC Analyzer

視聴中のページの上に小窓（HUD）を重ね、WebRTC の品質メトリクスをリアルタイム表示する Chrome 拡張。

```
WEBRTC ANALYZER              ⚠ 1  ⤓ ⚙ – ×
example.com · pc1                 connected
  route                     host→srflx (udp)
  rtt      ╭─╮╭──╮                   24.0 ms
  avail↑   ──╯  ╰─                  2.50 Mbps
↓ video 1920×1080 30fps                 H264
  bitrate  ╭──╮╭─╮                  2.48 Mbps
  jitter   ─╯  ╰─╯                     3.2 ms
  loss     ────╯╰─                    0.12 %
  buffer   ╭╮╭───╮                   328.0 ms   ← しきい値超過は色が変わる
  freeze   ─╯╰╯                            0
```

## できること

| | |
|---|---|
| リアルタイム表示 | 解像度・FPS・ビットレート・ジッター・パケットロス・RTT ほか |
| スパークライン | 各値の直近60秒の推移を折れ線で表示（範囲は変更可） |
| しきい値アラート | 超えた値の色が変わり、ヘッダーに超過件数が出る |
| CSV / JSON エクスポート | 計測履歴をファイルに書き出す（障害報告書への添付用） |
| 設定画面 | 更新間隔・表示項目・しきい値・履歴の保持時間 |

## なぜ webrtc-internals をそのまま使わないのか

`chrome://webrtc-internals` は Chromium 内部の WebUI 特権ページで、拡張のコンテンツスクリプトは注入できず、公開 JS API も存在しない（`chrome.debugger` にも WebRTC 統計を返すドメインは無い）。

そこで本拡張は、ページの `RTCPeerConnection` を Proxy でラップして全インスタンスを捕捉し、標準の **`getStats()`** を自前でポーリングする。webrtc-internals も内部的に同じ `getStats()` のデータ源を使っているため、**取得できる数値は実質同一**。

## インストール

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択

ツールバーのアイコンをクリックすると小窓の表示 / 非表示が切り替わる。

## 使い方

| 操作 | 動作 |
|---|---|
| ツールバーアイコン | 小窓の表示 / 非表示 |
| ヘッダーをドラッグ | 位置を移動（保存される） |
| `⤓` ボタン | CSV / JSON エクスポート、履歴のクリア |
| `⚙` ボタン | 設定画面を開く |
| `–` ボタン | 折りたたみ（保存される） |
| `×` ボタン | 非表示（アイコンで戻せる） |

WebRTC 接続が無いページには小窓は出ない。接続が切れると 5 秒後に自動で消える。

### エクスポート

`⤓` から CSV / JSON を書き出す。1行 = 1サンプル × 1ストリームで、PC単位の値（RTT・経路・利用可能帯域・接続状態）も各行に載せてあるので、そのままピボットテーブルにかけられる。

CSV は **BOM 付き UTF-8 + CRLF**、日時は `time_local` 列に `YYYY-MM-DD HH:MM:SS.mmm`（ローカル時刻）で入れてあるので、Excel でそのまま開いて日時として認識される。UTC が要る場合は `time_iso` 列を使う。

履歴はメモリ上にのみ持つ。ページを離れるかリロードすると消えるので、**書き出しは接続中に行うこと**。既定の保持時間は30分。

### しきい値

既定値。設定画面で変更でき、空欄にするとその段階の判定を行わない。

| 項目 | warn | crit | 根拠 |
|---|---|---|---|
| jitter | 30 ms | 50 ms | |
| buffer | 450 ms | 700 ms | WebRTC CDN 経由の平常値が 250〜300ms あるため、300ms では常時警告になる |
| loss | 0.5 % | 2 % | |
| rtt | 100 ms | 200 ms | 平常 50〜60ms のため、150ms では上昇の兆候を捉えられない |
| freeze（直近1サンプルの増分） | 1 回 | 3 回 | |

`freeze` だけは累積値ではなく**増分**で判定する。累積のままだと一度増えたきり永久に警告が出続けるため。

自分の配信環境の平常値は CSV を書き出して確認するのが早い。既に設定を変更したことがある場合は保存済みの値が優先されるので、新しい既定値を反映するには設定画面の「すべて既定値に戻す」を押す。

## 表示している値

すべて標準の [`getStats()`](https://www.w3.org/TR/webrtc-stats/) 由来。累積カウンタは差分計算済み。

| 表示 | 取得元 |
|---|---|
| 解像度 / FPS | `inbound-rtp` / `outbound-rtp` の `frameWidth`・`frameHeight`・`framesPerSecond` |
| bitrate | `bytesReceived` / `bytesSent` の差分 × 8 ÷ Δt |
| jitter | `jitter`（秒 → ms 換算） |
| buffer | `jitterBufferDelay ÷ jitterBufferEmittedCount`。実効遅延で、jitter より体感に近い |
| loss | `packetsLost ÷ (packetsLost + packetsReceived)` の差分比 |
| freeze | `freezeCount` |
| route | `transport.selectedCandidatePairId` を辿った先の `candidateType`。`relay` なら TURN 経由 |
| rtt | `candidate-pair.currentRoundTripTime`（送信側は `remote-inbound-rtp.roundTripTime`） |
| target | `outbound-rtp.targetBitrate` |
| limit | `outbound-rtp.qualityLimitationReason`。`cpu` / `bandwidth` なら送信側がボトルネック |
| src | 送信元の解像度。表示解像度と違えばダウンスケールが効いている |
| avail↑ / avail↓ | `candidate-pair` の `availableOutgoingBitrate` / `availableIncomingBitrate` |

Δt はポーリングの揺らぎを避けるため、レポート自身の `timestamp` から求めている。再接続や SSRC 変更でカウンタがリセットされて差分が負になったサンプルは破棄する。

**`avail↑` / `avail↓` は該当方向のストリームがあるときだけ出す。** `availableOutgoingBitrate` は candidate-pair の値なので、送信が1本も無くても既定値（Chrome では 300kbps）が返る。受信専用の接続でそのまま表示すると「送信できる帯域を測った」ように見えて誤読を招くため、出さないようにしてある。なお `availableIncomingBitrate` は Chrome がほぼ返さないので、多くの場合は元から空になる。

## 構成

```
manifest.json
src/inject/patch.js          MAIN world / 全フレーム / document_start
                             RTCPeerConnection を捕捉し getStats をポーリング、差分計算して postMessage
src/content/bridge.js        ISOLATED / 全フレーム / document_start
                             上り: メトリクスを Service Worker へ中継
                             下り: 更新間隔を MAIN world へ postMessage
src/bg/sw.js                 Service Worker
                             トップフレームと報告元フレームへ転送、アイコンで表示ON/OFF
src/content/overlay.js       ISOLATED / 全フレーム / document_idle
                             HUD 描画・履歴保持・スパークライン・エクスポート
src/content/overlay-style.js Shadow DOM に注入する HUD のスタイル
src/common/config.js         設定の既定値とマージ処理（オーバーレイと設定画面が共有）
src/options/                 設定画面
test/                        検証用ページ（後述）
```

### 設定の流れ

```
設定画面 ──▶ chrome.storage.local ──┬──▶ overlay.js   (storage.onChanged)
                                    └──▶ bridge.js ──▶ patch.js (postMessage)
```

MAIN world からは `chrome.storage` を読めないため、更新間隔だけは bridge.js が `postMessage` で送り込む。patch.js と bridge.js のどちらが先に立ち上がっても届くよう、patch.js 側からも `hello` を投げて設定を要求している。

### 設計上の要点

- **`world: "MAIN"`** — 既定の ISOLATED world は `window` が分離されており、そこで `RTCPeerConnection` を書き換えてもページには影響しない。なお従来の「`<script src="chrome-extension://…">` を挿す」手法はページの CSP でブロックされるが、manifest で宣言した MAIN world スクリプトは Chrome が直接実行するため影響を受けない。
- **`run_at: "document_start"`** — ページが `new RTCPeerConnection()` を呼ぶ前にラップを終える必要がある。
- **`all_frames: true`** — 配信プレーヤーは iframe 埋め込みが多く、`RTCPeerConnection` は子フレーム側にある。
- **Proxy の `construct` トラップ** — `RTCPeerConnection` は ES class なので、関数を自前定義して `prototype` を代入する古い手法では `new.target` 周りで壊れる。Proxy ならプロトタイプチェーン・`instanceof`・静的メソッドが素通りする。
- **Service Worker 経由の中継** — MAIN world から `window.top.postMessage` で親に送る手もあるが、クロスオリジンでは `targetOrigin: '*'` が必要になりメトリクスがページ側のスクリプトから読めてしまう。
- **フルスクリーン対応** — `position: fixed` はトップレイヤーの下に潜るため、`fullscreenchange` を監視して HUD をフルスクリーン要素の配下へ移す。相手が `<iframe>` の場合は親から重ねられないので、その iframe 自身のオーバーレイが担当する（overlay.js を全フレームで動かしているのはこのため）。

## 検証

### テストページ

ローカルに HTTP サーバを立てて開く。

```bash
python3 test/serve.py
```

`python3 -m http.server` ではなく `test/serve.py` を使うこと。ブラウザが JS をキャッシュして書き換えが反映されない事故を防ぐため、常に `Cache-Control: no-store` を返すようにしてある。

| URL | 用途 |
|---|---|
| http://localhost:8731/test/loopback.html | 拡張を読み込んだ状態で開く。右上に小窓が出れば成功 |
| http://localhost:8731/test/standalone.html | 拡張なしで収集と描画だけを検証（`test/shim.js` が chrome.* を代替） |
| http://localhost:8731/test/options-preview.html | 拡張なしで設定画面を検証 |

カメラ / マイクの許可は不要。canvas の映像とオシレータの音を同一ページ内でループバックする。
`window.__loopback.pc1` / `.pc2` から生 stats を直接叩ける。

```js
(await __loopback.pc2.getStats()).forEach(s => s.type === 'inbound-rtp' && console.log(s))
```

### 数値の突き合わせ

`chrome://webrtc-internals` を別タブで同時に開き、同一セッションで比較する。

- bitrate が ±5% 以内で一致するか
- 解像度・FPS が一致するか
- jitter の単位（webrtc-internals は秒表示なので 1000 倍の差に注意）

### デバッグの入口

| 見る場所 | 対象 |
|---|---|
| ページの DevTools コンソール | `patch.js`（MAIN world）。ページのログと混在する |
| DevTools > Sources > Content scripts | `bridge.js` / `overlay.js` |
| `chrome://extensions` の「Service Worker」リンク | `sw.js`。非アクティブ化するのでリンクを押して起こす |

HUD の中身はコンソールから触れる（Shadow Root は `open`）。

```js
document.querySelector('[data-wra]').shadowRoot.querySelector('.hud')
```

## 既知の制限

- **履歴はページを離れると消える**。永続化していないため、エクスポートは接続中に行う必要がある（[#2](https://github.com/a211chan/WebRTC-analyzer/issues/2)）
- **`<video>` 要素そのものがフルスクリーンの場合は重ねられない**。video は子要素を描画しないため。多くのプレーヤーはコンテナ div を全画面にするので通常は問題にならない（[#3](https://github.com/a211chan/WebRTC-analyzer/issues/3)）
- **Worker 内の `RTCPeerConnection` は捕捉できない**（現行仕様で Worker から WebRTC は使えないため、実質非該当）
- ページが `document_start` より前に `RTCPeerConnection` を退避することは原理的にできないが、極端な実装のサイトでは捕捉に失敗しうる

## 検討中

- [#1 再送・フリーズ関連の指標を追加する](https://github.com/a211chan/WebRTC-analyzer/issues/1) — `nackCount` / `pliCount` / `retransmittedPacketsReceived` / `framesDropped` / `totalFreezesDuration`。ロスゼロなのにフリーズする原因を切り分けるために要る
- [#2 履歴の永続化](https://github.com/a211chan/WebRTC-analyzer/issues/2)
- [#3 `<video>` 直接フルスクリーンへの対応](https://github.com/a211chan/WebRTC-analyzer/issues/3)

## プライバシー

この拡張は**収集したデータを一切外部へ送信しない**。テレメトリも解析SDKも入っていない（`src/` に `fetch` / `WebSocket` / `sendBeacon` は存在しない）。

- **IPアドレスは収集しない**。ICE candidate は種別（`host` / `srflx` / `relay`）だけを読み、アドレスは触らない
- **SDP・メディアの中身は扱わない**。`getStats()` の数値のみ
- `chrome.storage.local` に保存するのは設定と小窓の位置だけ。計測履歴はメモリ上にのみ置き、ページを離れると消える
- エクスポートは `chrome.downloads` 経由で行う。ページ側から書き出し内容は読めない

なお、WebRTC の利用有無を事前に判別できないため、コンテンツスクリプトは全ページ・全フレームに注入される。非WebRTCページではポーリングを行わず、コストはゼロになる。

## ライセンス

MIT License — [LICENSE](LICENSE) を参照。

WebRTC は本プロジェクトと無関係の一般名称であり、この拡張は Google および W3C とは無関係の非公式ツール。

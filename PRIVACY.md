# プライバシーポリシー / Privacy Policy — WebRTC Analyzer

最終更新: 2026-09-26

## 収集・送信するデータ
WebRTC Analyzer は、個人情報・閲覧履歴・通信内容を含め、**いかなるデータも外部へ送信しません**。テレメトリや解析 SDK は含まれていません。

## 端末内で扱うデータ
- ページ上の `RTCPeerConnection.getStats()` が返す数値（解像度・ビットレート・ジッター等）を、そのページ上の表示のためだけに読み取ります。
- ICE candidate は種別（host / srflx / relay）のみを参照し、IP アドレスは読み取りません。SDP やメディアの内容は扱いません。
- `chrome.storage.local` には設定値と表示窓の位置のみを保存します。計測履歴はメモリ上にのみ保持され、ページを離れると消去されます。
- エクスポートはユーザーが明示的に操作した場合にのみ、`chrome.downloads` で端末内に保存します。

## 第三者提供
データを第三者へ提供・販売・譲渡することはありません。

---

WebRTC Analyzer does not collect or transmit any data off the device. Stats read from `getStats()` are used only to render the on-page overlay; only settings and overlay position are stored in `chrome.storage.local`; IP addresses, SDP and media content are never read. No data is sold or shared with third parties.

連絡先 / Contact: https://github.com/a211chan/WebRTC-analyzer/issues

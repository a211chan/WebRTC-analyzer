# プライバシーポリシー / Privacy Policy — WebRTC Analyzer

最終更新: 2026-11-06

## 収集・送信するデータ
WebRTC Analyzer は、個人情報・閲覧履歴・通信内容を含め、**いかなるデータも外部へ送信しません**。テレメトリや解析 SDK は含まれていません。

## 端末内で扱うデータ
- ページ上の `RTCPeerConnection.getStats()` が返す数値（解像度・ビットレート・ジッター等）を、そのページ上の表示のためだけに読み取ります。
- ICE candidate は種別（host / srflx / relay）のみを参照し、IP アドレスは読み取りません。SDP やメディアの内容は扱いません。
- 品質低下の原因を切り分けるため、タブの表示状態（表示中／非表示）とフォーカスの有無、画面のサイズと拡大率、拡張ディスプレイの有無（`screen.isExtended`）、ウィンドウの画面上の位置、再生中の動画の表示サイズを数値として読み取ります。画面の内容は読み取りません。
- ログウィンドウ（別ウィンドウ）を開くディスプレイを選べるよう、`chrome.system.display` でディスプレイの一覧（名称・解像度・配置）を読み取ります。名称は設定画面の選択肢に表示するためだけに使い、保存するのは選んだディスプレイの識別子のみです。
- `chrome.storage.local` には設定値と計測履歴を保存します。履歴に含まれるのはホスト名・上記の数値（表示状態・画面構成を含む）・計測条件（ブラウザ名とバージョン、OS の種類、拡張のバージョン、計測間隔）のみで、URL のパスやクエリは含みません。最後の記録から一定時間（既定24時間）で自動的に削除され、設定画面から即時に全削除することもできます。
- 小窓の位置は保存しません。ログウィンドウの最後の位置と大きさは `chrome.storage.local` に、ログウィンドウが映しているタブは `chrome.storage.session`（メモリ上の領域。ブラウザを閉じると消去）に保持します。
- ストア版の更新の確認は Chrome 自身の更新の仕組み（`chrome.runtime.requestUpdateCheck`）を使い、拡張から外部へ通信することはありません。確認の結果（日時と新しい版の番号）だけを `chrome.storage.local` に保存します。
- エクスポートはユーザーが明示的に操作した場合にのみ、`chrome.downloads` で端末内に保存します。

## 第三者提供
データを第三者へ提供・販売・譲渡することはありません。

---

WebRTC Analyzer does not collect or transmit any data off the device. Stats read from `getStats()` are used only to render the on-page overlay; settings and measurement history (host name, numbers including tab visibility and screen layout such as screen size, pixel ratio, multi-display flag and window position, and measurement conditions such as browser name/version and OS type only, auto-deleted after 24 hours by default) are stored in `chrome.storage.local`, along with the log window's last position and size; the display list from `chrome.system.display` is used only to let you choose where the log window opens (only the chosen display's id is stored); update checks use Chrome's own update mechanism and the extension itself makes no network requests; IP addresses, SDP and media content are never read. No data is sold or shared with third parties.

連絡先 / Contact: https://github.com/a211chan/WebRTC-analyzer/issues

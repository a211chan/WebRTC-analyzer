/*
 * WebRTC Analyzer — Service Worker
 *
 * 役割は3つ。
 *   1. 各フレームの bridge.js から届いたメトリクスを、描画すべきフレームへ転送する
 *   2. ツールバーアイコンのクリックで表示ON/OFFを切り替える
 *   3. 小窓の位置をタブ単位で覚える
 *
 * SW は非アクティブ化されるので、状態はすべて chrome.storage に置く。
 *   - 表示ON/OFFと設定 : storage.local（全タブ共通。各フレームは onChanged で追従する）
 *   - 小窓の位置       : storage.session（タブ単位。ブラウザを閉じると消える）
 * 計測履歴の永続化は小窓（overlay.js）が storage.local へ直接書くので、ここは関与しない。
 */

const CHANNEL = 'webrtc-analyzer';

/** 自分で組み立てたファイル名だけを通す。ページ由来の文字列をパスに使わない。 */
const FILENAME = /^webrtc-\d{8}-\d{6}\.(csv|json)$/;

/** 小窓の位置。タブごとに1件 */
const UI_KEY = (tabId) => `ui:${tabId}`;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__wraChannel !== CHANNEL) return;

  // 小窓の ⚙ ボタンから。コンテンツスクリプトは openOptionsPage を呼べない。
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }

  // エクスポート。ページの DOM を経由させないため、保存はここで行う。
  if (msg.type === 'download') {
    save(msg).then(sendResponse);
    return true; // 非同期で応答する
  }

  const tabId = sender.tab?.id;

  // 小窓の位置。タブ単位で持つ。全タブ共通にすると、片方を動かしただけで
  // 別タブの小窓まで一緒に動いてしまう。
  if (msg.type === 'ui-get') {
    if (tabId == null) return;
    chrome.storage.session.get(UI_KEY(tabId)).then((v) => sendResponse(v[UI_KEY(tabId)] || null));
    return true;
  }
  if (msg.type === 'ui-set') {
    if (tabId == null) return;
    chrome.storage.session.set({ [UI_KEY(tabId)]: { pos: msg.pos || null } }).catch(() => {});
    return;
  }

  if (msg.type !== 'stats') return;
  if (tabId == null) return;

  const payload = { ...msg, frameId: sender.frameId ?? 0 };

  // トップフレームには常に全フレームぶんを集約して表示する
  send(tabId, payload, 0);

  // 報告元フレーム自身にも返す。プレーヤーが iframe でフルスクリーンになったとき、
  // トップの小窓はフルスクリーン要素の下に隠れてしまうため、そのフレーム自身が
  // 自前の小窓を出す必要がある。
  if (sender.frameId) send(tabId, payload, sender.frameId);
});

/*
 * ページの DOM に <a href="blob:..."> を挿す従来の方法は使わない。blob URL は
 * ページの origin で発行されるため、ページ側が MutationObserver で href を拾えば
 * 収集した履歴をそのまま読み取れてしまう。data: URL を SW に渡して
 * chrome.downloads に流せば、ページからは一切見えない。
 */
async function save(msg) {
  try {
    if (typeof msg.url !== 'string' || !msg.url.startsWith('data:')) throw new Error('不正なデータです');
    if (typeof msg.filename !== 'string' || !FILENAME.test(msg.filename)) throw new Error('不正なファイル名です');
    await chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function send(tabId, payload, frameId) {
  chrome.tabs.sendMessage(tabId, payload, { frameId }).catch(() => {
    // 該当フレームにオーバーレイが未注入 / 遷移直後などは黙って捨てる
  });
}

// 位置はタブに紐づく意味しかないので、タブを閉じたら捨てる
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(UI_KEY(tabId)).catch(() => {});
});

chrome.action.onClicked.addListener(async () => {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !enabled });
});

/*
 * 自動起動。インストール直後とブラウザ起動時に、enabled を autoStart に揃える。
 * autoStart が OFF（既定）なら、ユーザーがアイコンか設定画面で ON にするまで小窓は出ない。
 */
async function applyAutoStart() {
  const { autoStart = false } = await chrome.storage.local.get('autoStart');
  await chrome.storage.local.set({ enabled: autoStart === true });
}
chrome.runtime.onInstalled.addListener((d) => {
  // 拡張の更新やChrome自体の更新では、いまの表示状態を勝手に変えない
  if (d.reason === 'install') applyAutoStart();
});
chrome.runtime.onStartup.addListener(applyAutoStart);

/** ツールバーアイコンに現在の状態を出す */
function paintBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
}
chrome.storage.local.get('enabled').then((v) => paintBadge(v.enabled === true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) paintBadge(changes.enabled.newValue === true);
});

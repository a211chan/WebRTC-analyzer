/*
 * WebRTC Analyzer — Service Worker
 *
 * 役割は2つだけ。
 *   1. 各フレームの bridge.js から届いたメトリクスを、描画すべきフレームへ転送する
 *   2. ツールバーアイコンのクリックで表示ON/OFFを切り替える
 *
 * SW は非アクティブ化されるので状態を持たせない設計にしてある。
 * 表示ON/OFFは chrome.storage.local に置き、各フレームは storage.onChanged で追従する。
 */

const CHANNEL = 'webrtc-analyzer';

/** 自分で組み立てたファイル名だけを通す。ページ由来の文字列をパスに使わない。 */
const FILENAME = /^webrtc-\d{8}-\d{6}\.(csv|json)$/;

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

  if (msg.type !== 'stats') return;

  const tabId = sender.tab?.id;
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

chrome.action.onClicked.addListener(async () => {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !enabled });
});

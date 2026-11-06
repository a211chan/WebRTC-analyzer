/*
 * WebRTC Analyzer — Service Worker
 *
 * 役割は3つ。
 *   1. 各フレームの bridge.js から届いたメトリクスを、描画すべきフレームへ転送する
 *   2. ツールバーアイコンのクリックで表示ON/OFFを切り替える
 *   3. ログウィンドウ（src/logwin）を開き、どのタブを映すかを決める
 *
 * SW は非アクティブ化されるので、状態はすべて chrome.storage に置く。
 *   - 表示ON/OFFと設定       : storage.local（全タブ共通。各フレームは onChanged で追従する）
 *   - ログウィンドウの状態   : storage.session の logwin（ブラウザを閉じると消える）
 *   - ログウィンドウの位置   : storage.local の logwinLast（手で動かした最後の位置と大きさ）
 * 小窓の位置は覚えない。表示を ON にするたびに右上（拡張アイコンの近く）から出す。
 * 計測履歴の永続化は小窓（overlay.js）が storage.local へ直接書くので、ここは関与しない。
 */

importScripts('../common/config.js');

const CHANNEL = 'webrtc-analyzer';
const LOGWIN_URL = chrome.runtime.getURL('src/logwin/logwin.html');

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

  const tabId = sender.tab?.id;

  // 小窓の ⧉ から。ログウィンドウでこのタブを映す
  if (msg.type === 'logwin-open') {
    if (tabId == null) return;
    showTab(tabId, sender.tab.windowId);
    return;
  }
  // 小窓が読み込まれたとき。ログウィンドウがこのタブを映しているなら小窓は出さない
  if (msg.type === 'logwin-get') {
    if (tabId == null) return;
    getLogwin().then((cur) => sendResponse({ open: cur?.tabId === tabId }));
    return true;
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
  // 前回も ON だと値が変わらず onChanged が来ないので、表示先はここでも揃える
  if (autoStart === true) onEnabled(true);
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
  if (area !== 'local' || !changes.enabled) return;
  paintBadge(changes.enabled.newValue === true);
  onEnabled(changes.enabled.newValue === true);
});

// ------------------------------------------------------------- ログウィンドウ

/*
 * 表示先が 'window' なら、ON でログウィンドウを開く。OFF ではどちらの設定でもログウィンドウを閉じる
 * （表示していないのにウィンドウだけ残っても意味がない）。
 * ON の時点ではどのタブを見たいか決まっていないので、アクティブなタブを追いかける（follow）。
 */
async function onEnabled(on) {
  if (!on) {
    const cur = await getLogwin();
    if (cur) chrome.windows.remove(cur.windowId).catch(() => setLogwin(null));
    return;
  }
  const cfg = await WRA_CONFIG.load();
  if (cfg.display !== 'window') return;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }).catch(() => null);
  const tab = win?.tabs?.find((t) => t.active);
  openLogwin({ tabId: tab?.id ?? null, follow: true, focused: false, srcWindow: win });
}

/** 小窓の ⧉ から。すでに開いていればそのウィンドウでこのタブを映す */
async function showTab(tabId, windowId) {
  const cur = await getLogwin();
  if (cur && (await alive(cur.windowId))) {
    await setLogwin({ ...cur, tabId, follow: false });
    chrome.windows.update(cur.windowId, { focused: true }).catch(() => {});
    return;
  }
  const win = await chrome.windows.get(windowId).catch(() => null);
  openLogwin({ tabId, follow: false, focused: true, srcWindow: win });
}

/** 同時に2回呼ばれても（アイコンの連打・自動起動と onChanged の重なり）1枚しか開かない */
let opening = null;
function openLogwin(opts) {
  opening ||= doOpen(opts).finally(() => (opening = null));
  return opening;
}

async function doOpen({ tabId, follow, focused, srcWindow }) {
  const cur = await getLogwin();
  if (cur && (await alive(cur.windowId))) {
    await setLogwin({ ...cur, tabId, follow });
    return;
  }
  const cfg = await WRA_CONFIG.load();
  const bounds = await placement(cfg.logWindow, srcWindow);
  try {
    const w = await chrome.windows.create({ url: LOGWIN_URL, type: 'popup', focused, ...bounds });
    await setLogwin({ windowId: w.id, tabId, follow });
  } catch (_) {
    // 位置がどのディスプレイにも載らないなどで失敗したら、位置はブラウザに任せる
    const w = await chrome.windows.create({ url: LOGWIN_URL, type: 'popup', focused, width: bounds.width, height: bounds.height });
    await setLogwin({ windowId: w.id, tabId, follow });
  }
}

/*
 * 開く位置。手で動かした最後の位置があればそれ（そのディスプレイが今も繋がっている場合だけ）、
 * なければ設定のディスプレイ・置き場所・大きさから決める。
 * ディスプレイ未指定（または外れている）なら小窓を開いたブラウザウィンドウと同じディスプレイ、
 * それも分からなければプライマリ。
 */
async function placement(lw, srcWindow) {
  const displays = await chrome.system.display.getInfo().catch(() => []);
  const on = (x, y) => displays.find((d) => inside(d.bounds, x, y));

  if (lw.rememberLast) {
    const { logwinLast: b } = await chrome.storage.local.get('logwinLast');
    if (b && [b.left, b.top, b.width, b.height].every(Number.isFinite) && on(b.left + b.width / 2, b.top + 20)) {
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    }
  }

  let d = lw.displayId ? displays.find((x) => x.id === lw.displayId) : null;
  if (!d && srcWindow && Number.isFinite(srcWindow.left)) {
    d = on(srcWindow.left + srcWindow.width / 2, srcWindow.top + srcWindow.height / 2);
  }
  d ||= displays.find((x) => x.isPrimary) || displays[0];
  if (!d) return { width: lw.width, height: lw.height };
  return WRA_CONFIG.logwinRect(lw, d);
}

function inside(r, x, y) {
  return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

async function alive(windowId) {
  return chrome.windows.get(windowId).then(() => true, () => false);
}

async function getLogwin() {
  return (await chrome.storage.session.get('logwin')).logwin || null;
}

/** 状態を書き、映す対象から外れたタブと新しく映すタブに知らせる（小窓を消す / 戻す） */
async function setLogwin(next) {
  const prev = await getLogwin();
  if (next) await chrome.storage.session.set({ logwin: next });
  else await chrome.storage.session.remove('logwin');
  if (prev?.tabId != null && prev.tabId !== next?.tabId) notify(prev.tabId, false);
  if (next?.tabId != null) notify(next.tabId, true);
}

/** frameId を付けずに送り、子フレームの小窓（全画面時用）にも知らせる */
function notify(tabId, open) {
  chrome.tabs.sendMessage(tabId, { __wraChannel: CHANNEL, type: 'logwin', open }).catch(() => {});
}

// ログウィンドウを閉じたら、映していたタブに小窓を戻す
chrome.windows.onRemoved.addListener(async (windowId) => {
  const cur = await getLogwin();
  if (cur?.windowId === windowId) setLogwin(null);
});

// 手で動かした・広げた位置と大きさを覚える
chrome.windows.onBoundsChanged.addListener(async (w) => {
  const cur = await getLogwin();
  if (cur?.windowId !== w.id) return;
  const cfg = await WRA_CONFIG.load();
  if (!cfg.logWindow.rememberLast) return;
  chrome.storage.local.set({ logwinLast: { left: w.left, top: w.top, width: w.width, height: w.height } });
});

// 追いかけるモード: アクティブなタブ・フォーカスしたブラウザウィンドウが変わったら映す先を替える
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const cur = await getLogwin();
  if (!cur?.follow || cur.tabId === tabId) return;
  const w = await chrome.windows.get(windowId).catch(() => null);
  if (w?.type === 'normal') setLogwin({ ...cur, tabId });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const cur = await getLogwin();
  if (!cur?.follow) return;
  const w = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
  if (w?.type !== 'normal') return;
  const tab = w.tabs?.find((t) => t.active);
  if (tab && tab.id !== cur.tabId) setLogwin({ ...cur, tabId: tab.id });
});

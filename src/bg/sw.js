/*
 * WebRTC Analyzer — Service Worker
 *
 * 役割は4つ。
 *   1. 各フレームの bridge.js から届いたメトリクスを、描画すべきフレームへ転送する
 *   2. ツールバーアイコンのクリックで表示ON/OFFを切り替える
 *   3. 小窓が集めたログを chrome.storage.session に溜める（設定画面から保存できるように）
 *   4. 小窓の位置をタブ単位で覚える
 *
 * SW は非アクティブ化されるので、状態はすべて chrome.storage に置く。
 *   - 表示ON/OFFと設定 : storage.local（全タブ共通。各フレームは onChanged で追従する）
 *   - ログと小窓の位置 : storage.session（ブラウザを閉じると消える。タブ単位）
 *
 * ログを storage.session に置くのは、配信が止まった瞬間に小窓が消えても
 * 履歴が残るようにするため。local に置くとディスクに溜まり続けてゴミになる。
 */

const CHANNEL = 'webrtc-analyzer';

/** 自分で組み立てたファイル名だけを通す。ページ由来の文字列をパスに使わない。 */
const FILENAME = /^webrtc-\d{8}-\d{6}\.(csv|json)$/;

/** ログ本体のキー。タブごとに1件 */
const LOG_KEY = (tabId) => `log:${tabId}`;
/** 設定画面が一覧を出すための目次。本体を読まずに済ませる */
const LOG_INDEX = 'logIndex';
/** 小窓の位置。タブごとに1件 */
const UI_KEY = (tabId) => `ui:${tabId}`;

/** 1タブぶんの上限。1秒間隔なら 1ストリームで約100分ぶん */
const MAX_ROWS = 6000;
/** 保持するタブ数。超えたら更新がいちばん古いものから捨てる */
const MAX_LOGS = 8;

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

  if (msg.type === 'log-append') {
    if (tabId == null) return;
    queue(() => appendLog(tabId, msg));
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

// --------------------------------------------------------------- ログの蓄積

/*
 * 目次とログ本体の更新は read-modify-write なので、複数のタブから同時に来ると
 * 取りこぼす。直列に流す。
 */
let chain = Promise.resolve();
function queue(fn) {
  chain = chain.then(fn).catch(() => {});
  return chain;
}

async function appendLog(tabId, msg) {
  if (!Array.isArray(msg.streams) || !msg.streams.length) return;

  const key = LOG_KEY(tabId);
  const now = Date.now();
  const stored = (await chrome.storage.session.get(key))[key];
  const log = stored || { tabId, startedAt: now, streams: {} };

  log.host = str(msg.host, 200) || log.host || 'page';
  log.title = str(msg.title, 200) || log.title || '';
  log.url = str(msg.url, 500) || log.url || '';
  log.updatedAt = now;

  for (const st of msg.streams) {
    if (!st || typeof st.key !== 'string' || !Array.isArray(st.samples)) continue;
    const k = str(st.key, 300);
    const cur = log.streams[k] || { meta: st.meta || {}, samples: [] };
    cur.meta = st.meta || cur.meta;
    for (const s of st.samples) if (s && typeof s.t === 'number') cur.samples.push(s);
    log.streams[k] = cur;
  }

  trim(log);
  log.rows = count(log);
  if (!log.rows) return;

  try {
    await chrome.storage.session.set({ [key]: log });
  } catch (_) {
    // 容量に当たったら、いちばん古いログを捨ててもう一度だけ試す
    await evict(1);
    try {
      await chrome.storage.session.set({ [key]: log });
    } catch (__) {
      return;
    }
  }
  await index(tabId, log);
}

function count(log) {
  let n = 0;
  for (const s of Object.values(log.streams)) n += s.samples.length;
  return n;
}

/** 上限を超えたぶんを、いちばん長いストリームの古い側から削る */
function trim(log) {
  let total = count(log);
  while (total > MAX_ROWS) {
    let longest = null;
    for (const s of Object.values(log.streams)) {
      if (!longest || s.samples.length > longest.samples.length) longest = s;
    }
    if (!longest || !longest.samples.length) break;
    const drop = Math.min(longest.samples.length, total - MAX_ROWS, 200);
    longest.samples.splice(0, drop);
    total -= drop;
  }
}

async function index(tabId, log) {
  const all = (await chrome.storage.session.get(LOG_INDEX))[LOG_INDEX] || {};
  all[tabId] = {
    tabId,
    host: log.host,
    title: log.title,
    url: log.url,
    startedAt: log.startedAt,
    updatedAt: log.updatedAt,
    rows: log.rows,
  };
  await chrome.storage.session.set({ [LOG_INDEX]: all });
  const over = Object.keys(all).length - MAX_LOGS;
  if (over > 0) await evict(over);
}

/** 更新がいちばん古いログから n 件捨てる */
async function evict(n) {
  const all = (await chrome.storage.session.get(LOG_INDEX))[LOG_INDEX] || {};
  const old = Object.values(all)
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(0, n);
  if (!old.length) return;
  for (const e of old) delete all[e.tabId];
  await chrome.storage.session.remove(old.map((e) => LOG_KEY(e.tabId)));
  await chrome.storage.session.set({ [LOG_INDEX]: all });
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/*
 * タブを閉じてもログは残す。「配信が終わってタブを閉じたあとに、設定画面から
 * 保存する」という使い方を想定している。消えるのはブラウザを閉じたとき。
 * 位置だけはタブに紐づく意味しかないので捨てる。
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(UI_KEY(tabId)).catch(() => {});
});

chrome.action.onClicked.addListener(async () => {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !enabled });
});

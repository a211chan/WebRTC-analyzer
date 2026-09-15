/*
 * WebRTC Analyzer — 設定画面
 *
 * chrome.storage.local に書くだけ。オーバーレイ側は storage.onChanged で追従し、
 * ポーリング間隔は bridge.js が MAIN world へ postMessage で流し込む。
 */
(() => {
  'use strict';

  const { DEFAULTS, KEYS, merge } = WRA_CONFIG;

  /** 表示項目のラベル。DEFAULTS.fields のキーと対応する */
  const FIELD_LABELS = {
    route: 'route（接続経路）',
    avail: 'avail（利用可能帯域）',
    codec: 'codec（コーデック）',
    resolution: '解像度',
    fps: 'FPS',
    bitrate: 'bitrate（ビットレート）',
    target: 'target（目標ビットレート）',
    jitter: 'jitter（ジッター）',
    buffer: 'buffer（ジッターバッファ遅延）',
    loss: 'loss（パケットロス）',
    freeze: 'freeze（フリーズ回数）',
    rtt: 'rtt（往復遅延）',
    limit: 'limit（送信品質の制限理由）',
    src: 'src（送信元解像度）',
  };

  /** しきい値の行定義 */
  const THRESHOLDS = [
    ['jitterMs', 'jitter', 'ms', '到着間隔のばらつき。平均が低くてもバーストで乱れることがある'],
    ['bufferMs', 'buffer', 'ms', '実効遅延。jitter に対して大きすぎるならロスや順序入れ替わりの痕跡'],
    ['lossPct', 'loss', '%', '直近1サンプルでのパケットロス率'],
    ['rttMs', 'rtt', 'ms', '往復遅延'],
    ['freeze', 'freeze', '回', '直近1サンプルでのフリーズ増分（累積値ではない）'],
  ];

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');

  let cfg = structuredClone(DEFAULTS);

  // ------------------------------------------------------------ 組み立て

  function buildFields() {
    $('fields').innerHTML = Object.keys(DEFAULTS.fields)
      .map(
        (k) =>
          `<label class="field"><input type="checkbox" data-field="${k}"> ${escapeHtml(FIELD_LABELS[k] || k)}</label>`
      )
      .join('');
  }

  function buildThresholds() {
    document.querySelector('#thresholds tbody').innerHTML = THRESHOLDS.map(
      ([key, label, unit, desc]) => `
      <tr>
        <td class="name">${escapeHtml(label)}</td>
        <td><input type="number" data-th="${key}" data-lv="warn" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span></td>
        <td><input type="number" data-th="${key}" data-lv="crit" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span></td>
        <td class="desc">${escapeHtml(desc)}</td>
      </tr>`
    ).join('');
  }

  // ------------------------------------------------------------ 反映

  function paint() {
    $('intervalMs').value = cfg.intervalMs;
    $('sparkSeconds').value = cfg.sparkSeconds;
    $('historyMinutes').value = cfg.historyMinutes;
    $('sparkline').checked = !!cfg.sparkline;
    $('alerts').checked = !!cfg.alerts;

    for (const el of document.querySelectorAll('[data-field]')) {
      el.checked = cfg.fields[el.dataset.field] !== false;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const v = cfg.thresholds[el.dataset.th]?.[el.dataset.lv];
      el.value = v == null ? '' : v;
    }

    // スパークラインOFFなら範囲指定は意味がない
    $('sparkSeconds').disabled = !cfg.sparkline;
  }

  // ------------------------------------------------------------ 収集と保存

  function collect() {
    const next = structuredClone(cfg);

    next.intervalMs = clampInt($('intervalMs').value, 200, 10000, DEFAULTS.intervalMs);
    next.sparkSeconds = clampInt($('sparkSeconds').value, 10, 600, DEFAULTS.sparkSeconds);
    next.historyMinutes = clampInt($('historyMinutes').value, 1, 240, DEFAULTS.historyMinutes);
    next.sparkline = $('sparkline').checked;
    next.alerts = $('alerts').checked;

    for (const el of document.querySelectorAll('[data-field]')) {
      next.fields[el.dataset.field] = el.checked;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const raw = el.value.trim();
      const v = raw === '' ? null : Number(raw);
      next.thresholds[el.dataset.th][el.dataset.lv] = Number.isFinite(v) ? v : null;
    }
    return next;
  }

  function clampInt(raw, lo, hi, fallback) {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  async function save() {
    cfg = collect();
    // enabled は小窓の × とツールバーのアイコンが持つ状態なので、ここでは書かない
    const { enabled, ...rest } = cfg;
    await chrome.storage.local.set(rest);
    paint();
    flash('保存しました');
  }

  function flash(text) {
    statusEl.textContent = text;
    statusEl.classList.add('on');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => statusEl.classList.remove('on'), 1600);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // ------------------------------------------------------------ ログ

  /*
   * 小窓が集めたログは Service Worker が chrome.storage.session に溜めている。
   * 設定画面は拡張のページなので、そこから直接読めばよい（コンテンツスクリプトは
   * session 領域に触れないため、溜める側だけが SW を経由している）。
   *
   * session 領域はブラウザを閉じると消える。ログがディスクに溜まり続けて
   * ゴミにならないよう、保持期間はそこまでと決めてある。
   */
  const LOG_INDEX = 'logIndex';
  const LOG_KEY = (tabId) => `log:${tabId}`;

  async function loadLogs() {
    const all = (await chrome.storage.session.get(LOG_INDEX))[LOG_INDEX] || {};
    return Object.values(all).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function paintLogs() {
    const list = await loadLogs();
    const el = $('logs');

    if (!list.length) {
      el.innerHTML = '<div class="logs-empty">まだログがありません。計測が始まると自動で溜まります。</div>';
      return;
    }

    el.innerHTML = list
      .map(
        (e) => `
      <div class="log" data-tab="${escapeHtml(String(e.tabId))}">
        <div class="log-main">
          <span class="log-host">${escapeHtml(e.host || 'page')}</span>
          <span class="log-title">${escapeHtml(e.title || '')}</span>
        </div>
        <div class="log-meta">${escapeHtml(span(e))} · ${escapeHtml(String(e.rows || 0))} 行</div>
        <div class="log-acts">
          <button data-dl="csv">CSV</button>
          <button data-dl="json">JSON</button>
          <button data-del="1" class="danger">削除</button>
        </div>
      </div>`
      )
      .join('');
  }

  function span(e) {
    const from = e.startedAt ? clock(e.startedAt) : '';
    const to = e.updatedAt ? clock(e.updatedAt) : '';
    return from && to ? `${from} → ${to}` : from || to || '';
  }

  function clock(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function downloadLog(tabId, kind) {
    const key = LOG_KEY(tabId);
    const log = (await chrome.storage.session.get(key))[key];
    const rows = log ? WRA_EXPORT.rows(Object.values(log.streams || {})) : [];
    if (!rows.length) {
      logFlash('このログは既に消えています');
      await paintLogs();
      return;
    }

    const { text, mime } = WRA_EXPORT.build(rows, kind);
    // ここは拡張のページなので blob URL も拡張の origin で発行される。
    // 計測対象のページからは見えない。
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    try {
      await chrome.downloads.download({
        url,
        filename: `webrtc-${WRA_EXPORT.fileStamp(log.startedAt || Date.now())}.${kind}`,
        saveAs: false,
      });
      logFlash(`${rows.length} 行を書き出しました`);
    } catch (e) {
      logFlash(`保存できませんでした: ${String(e?.message || e)}`);
    }
    // 保存の開始後すぐに revoke すると取りこぼすので少し待つ
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function removeLog(tabId) {
    const all = (await chrome.storage.session.get(LOG_INDEX))[LOG_INDEX] || {};
    delete all[tabId];
    await chrome.storage.session.set({ [LOG_INDEX]: all });
    await chrome.storage.session.remove(LOG_KEY(tabId));
    await paintLogs();
  }

  async function clearLogs() {
    const list = await loadLogs();
    await chrome.storage.session.remove([LOG_INDEX, ...list.map((e) => LOG_KEY(e.tabId))]);
    await paintLogs();
    logFlash('ログを削除しました');
  }

  function logFlash(text) {
    const el = $('logs-status');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(logFlash.t);
    logFlash.t = setTimeout(() => el.classList.remove('on'), 2600);
  }

  // ------------------------------------------------------------ 起動

  (async () => {
    buildFields();
    buildThresholds();
    cfg = merge(await chrome.storage.local.get(KEYS));
    paint();
    paintLogs();

    document.addEventListener('change', (e) => {
      if (e.target.matches('input')) save();
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(KEYS.filter((k) => k !== 'enabled'));
      cfg = structuredClone(DEFAULTS);
      paint();
      flash('既定値に戻しました');
    });

    $('logs').addEventListener('click', (e) => {
      const row = e.target.closest?.('.log');
      if (!row) return;
      const tabId = row.dataset.tab;
      const kind = e.target.dataset?.dl;
      if (kind) downloadLog(tabId, kind);
      else if (e.target.dataset?.del) removeLog(tabId);
    });

    $('logs-clear').addEventListener('click', clearLogs);

    // 計測中のタブがあれば行数が伸び続ける。開きっぱなしの設定画面も追従させる。
    chrome.storage.session.onChanged?.addListener((changes) => {
      if (LOG_INDEX in changes) paintLogs();
    });
  })();
})();

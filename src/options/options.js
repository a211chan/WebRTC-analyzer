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
    nack: 'nack（再送要求の回数）',
    pli: 'pli（キーフレーム要求の回数）',
    rtx: 'rtx（再送で回復したパケット数）',
    dropped: 'dropped（表示を捨てたフレーム数）',
    freezeDur: 'freeze時間（フリーズの長さ）',
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
    $('persist').checked = !!cfg.persist;
    $('persistHours').value = cfg.persistHours;
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
    $('persistHours').disabled = !cfg.persist;
  }

  // ------------------------------------------------------------ 収集と保存

  function collect() {
    const next = structuredClone(cfg);

    next.intervalMs = clampInt($('intervalMs').value, 200, 10000, DEFAULTS.intervalMs);
    next.sparkSeconds = clampInt($('sparkSeconds').value, 10, 600, DEFAULTS.sparkSeconds);
    next.historyMinutes = clampInt($('historyMinutes').value, 1, 240, DEFAULTS.historyMinutes);
    next.persist = $('persist').checked;
    next.persistHours = clampInt($('persistHours').value, 1, 720, DEFAULTS.persistHours);
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

  // ------------------------------------------------------------ 保存済みの履歴

  const { listSessions, loadRows, removeSessions, build, dataUrl, filename, localStamp } = WRA_EXPORT;
  let sessions = [];

  async function paintSessions() {
    sessions = await listSessions();
    const tbody = document.querySelector('#sessions tbody');
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="desc">まだありません</td></tr>';
      return;
    }
    tbody.innerHTML = sessions
      .map(
        (s, i) => `
      <tr>
        <td>${escapeHtml(localStamp(s.start).slice(0, 19))}</td>
        <td>${escapeHtml(localStamp(s.end).slice(0, 19))}</td>
        <td class="name">${escapeHtml(s.host)}</td>
        <td>${s.rows}</td>
        <td class="ops">
          <button data-sess="${i}" data-op="csv">CSV</button>
          <button data-sess="${i}" data-op="json">JSON</button>
          <button data-sess="${i}" data-op="del" class="danger">削除</button>
        </td>
      </tr>`
      )
      .join('');
  }

  async function onSession(e) {
    const btn = e.target.closest('[data-sess]');
    if (!btn) return;
    const s = sessions[Number(btn.dataset.sess)];
    if (!s) return;
    const op = btn.dataset.op;
    if (op === 'del') {
      await removeSessions([s]);
      await paintSessions();
      flash('削除しました');
      return;
    }
    const rows = await loadRows(s);
    if (!rows.length) {
      flash('データがありません');
      return;
    }
    const { text, mime } = build(op, rows);
    // 設定画面は拡張のページなので chrome.downloads を直接呼べる
    await chrome.downloads.download({ url: dataUrl(text, mime), filename: filename(op, s.start), saveAs: false });
    flash(`${rows.length} 行を書き出しました`);
  }

  // ------------------------------------------------------------ 起動

  (async () => {
    buildFields();
    buildThresholds();
    cfg = merge(await chrome.storage.local.get(KEYS));
    paint();

    document.addEventListener('change', (e) => {
      if (e.target.matches('input')) save();
    });

    await paintSessions();
    document.querySelector('#sessions').addEventListener('click', onSession);
    $('refreshSessions').addEventListener('click', paintSessions);
    $('clearSessions').addEventListener('click', async () => {
      if (!confirm('保存済みの履歴をすべて削除しますか？')) return;
      await removeSessions(await listSessions());
      await paintSessions();
      flash('すべて削除しました');
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(KEYS.filter((k) => k !== 'enabled'));
      cfg = structuredClone(DEFAULTS);
      paint();
      flash('既定値に戻しました');
    });
  })();
})();

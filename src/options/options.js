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
    page: 'page（タブの表示状態・画面構成・表示サイズ）',
    limShare: 'lim（制限理由ごとの時間割合・解像度変更回数）',
    nack: 'nack（再送要求の回数）',
    pli: 'pli（キーフレーム要求の回数）',
    rtx: 'rtx（再送で回復したパケット数）',
    dropped: 'dropped（表示を捨てたフレーム数）',
    freezeDur: 'freeze時間（フリーズの長さ）',
    conceal: 'conceal（音声の補間率）',
  };

  /** しきい値の行定義。dir は config.js 側の仕様で、ここでは表示のみ */
  const THRESHOLDS = [
    ['jitterMs', 'jitter', 'ms', '到着間隔のばらつき。平均が低くてもバーストで乱れることがある'],
    ['bufferMs', 'buffer', 'ms', '実効遅延。jitter に対して大きすぎるならロスや順序入れ替わりの痕跡'],
    ['lossPct', 'loss', '%', '直近1サンプルでのパケットロス率'],
    ['rttMs', 'rtt', 'ms', '往復遅延'],
    ['freeze', 'freeze', '回', '直近1サンプルでのフリーズ増分（累積値ではない）。レポートでは期間中の合計回数と比べる'],
    ['fps', 'fps', 'fps', '受信映像のフレームレート。配信側が 15fps などの場合は、それに合わせて下げるか空欄にする'],
    ['concealPct', 'conceal', '%', '受信音声のうち、欠けて推測で埋めたサンプルの割合。音声の途切れ・ノイズの目安'],
    ['limitPct', '品質制限', '%', '送信レポート用。期間中に CPU・帯域による品質制限がかかっていた時間の割合（小窓では使わない）'],
  ];

  /** レポートの章。DEFAULTS.report.sections のキーと対応する */
  const REPORT_SECTIONS = {
    summary: '総合判定と所見（文章）',
    kpi: '主要指標（数値カード）',
    judgement: 'しきい値判定の表',
    charts: '時系列グラフ',
    events: 'イベント一覧（フリーズ・品質制限・再接続・解像度の変化など）',
    stream: 'ストリームの概要（コーデック・解像度・経路・再送）',
    conditions: '計測条件（ブラウザ・間隔・非表示時間など）',
    criteria: '判定基準（しきい値の一覧）',
  };
  const REPORT_CHARTS = {
    bitrate: '受信ビットレート（映像）',
    fps: 'フレームレート',
    buffer: 'ジッターバッファ遅延',
    loss: 'パケットロス率',
    rtt: '往復遅延（RTT）',
    conceal: '音声の補間率',
  };
  const REPORT_SEND_CHARTS = {
    bitrate: '送信ビットレートと推定上り帯域',
    fps: '送信とカメラのフレームレート',
    loss: 'パケットロス率（受け手の報告）',
    rtt: '往復遅延（RTT）',
  };

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
    document.querySelector('#thresholds tbody').innerHTML = THRESHOLDS.map(([key, label, unit, desc]) => {
      // fps は「低いほど悪い」。向きを取り違えると意味が反転するので明示する。
      const below = DEFAULTS.thresholds[key]?.dir === 'below';
      const dirMark = `<span class="dir">${below ? '以下' : '以上'}</span>`;
      return `
      <tr>
        <td class="name">${escapeHtml(label)}${below ? '<span class="inv" title="低いほど悪い指標">↓</span>' : ''}</td>
        <td><input type="number" data-th="${key}" data-lv="warn" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span>${dirMark}</td>
        <td><input type="number" data-th="${key}" data-lv="crit" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span>${dirMark}</td>
        <td class="desc">${escapeHtml(desc)}</td>
      </tr>`;
    }).join('');
  }

  function buildReport() {
    const box = (attr, labels) =>
      Object.entries(labels)
        .map(([k, l]) => `<label class="field"><input type="checkbox" ${attr}="${k}"> ${escapeHtml(l)}</label>`)
        .join('');
    $('reportSections').innerHTML = box('data-rsec', REPORT_SECTIONS);
    $('reportCharts').innerHTML = box('data-rchart', REPORT_CHARTS);
    $('reportSendCharts').innerHTML = box('data-rschart', REPORT_SEND_CHARTS);
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
    $('autoStart').checked = !!cfg.autoStart;
    for (const el of document.querySelectorAll('input[name="display"]')) el.checked = el.value === cfg.display;
    $('scale').value = cfg.scale;
    paintLogwin();
    $('toggleEnabled').textContent = cfg.enabled ? 'OFFにする' : 'ONにする';
    $('enabledState').textContent = cfg.enabled ? '現在: ON' : '現在: OFF';

    for (const el of document.querySelectorAll('[data-field]')) {
      el.checked = cfg.fields[el.dataset.field] !== false;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const v = cfg.thresholds[el.dataset.th]?.[el.dataset.lv];
      el.value = v == null ? '' : v;
    }

    $('reportTitle').value = cfg.report.title;
    $('reportSendTitle').value = cfg.report.sendTitle;
    $('reportAuthor').value = cfg.report.author;
    $('reportExcludeBg').checked = !!cfg.report.excludeBackground;
    for (const el of document.querySelectorAll('input[name="reportMode"]')) el.checked = el.value === cfg.report.mode;
    for (const el of document.querySelectorAll('[data-rsec]')) el.checked = cfg.report.sections[el.dataset.rsec] !== false;
    for (const el of document.querySelectorAll('[data-rchart]')) el.checked = cfg.report.charts[el.dataset.rchart] !== false;
    for (const el of document.querySelectorAll('[data-rschart]')) el.checked = cfg.report.sendCharts[el.dataset.rschart] !== false;
    // グラフの章を外したら、グラフの種類は選んでも意味がない
    for (const el of document.querySelectorAll('[data-rchart], [data-rschart]')) el.disabled = !cfg.report.sections.charts;

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
    next.autoStart = $('autoStart').checked;
    next.display = document.querySelector('input[name="display"]:checked')?.value || DEFAULTS.display;
    const { SCALE, LOGWIN_SIZE } = WRA_CONFIG;
    // 倍率は刻みに揃える（⊖ / ⊕ と同じ段階にする）
    next.scale = Math.round(clampInt($('scale').value, SCALE.min, SCALE.max, DEFAULTS.scale) / SCALE.step) * SCALE.step;
    next.logWindow.mode = document.querySelector('input[name="lwMode"]:checked')?.value || DEFAULTS.logWindow.mode;
    next.logWindow.displayId = $('lwDisplay').value;
    next.logWindow.anchor = $('lwAnchor').value;
    next.logWindow.width = clampInt($('lwWidth').value, LOGWIN_SIZE.minW, LOGWIN_SIZE.maxW, DEFAULTS.logWindow.width);
    next.logWindow.height = clampInt($('lwHeight').value, LOGWIN_SIZE.minH, LOGWIN_SIZE.maxH, DEFAULTS.logWindow.height);
    next.logWindow.rememberLast = $('lwRemember').checked;

    for (const el of document.querySelectorAll('[data-field]')) {
      next.fields[el.dataset.field] = el.checked;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const raw = el.value.trim();
      const v = raw === '' ? null : Number(raw);
      next.thresholds[el.dataset.th][el.dataset.lv] = Number.isFinite(v) ? v : null;
    }
    next.report.title = $('reportTitle').value.trim() || DEFAULTS.report.title;
    next.report.sendTitle = $('reportSendTitle').value.trim() || DEFAULTS.report.sendTitle;
    next.report.author = $('reportAuthor').value.trim();
    next.report.excludeBackground = $('reportExcludeBg').checked;
    next.report.mode = document.querySelector('input[name="reportMode"]:checked')?.value || DEFAULTS.report.mode;
    for (const el of document.querySelectorAll('[data-rsec]')) next.report.sections[el.dataset.rsec] = el.checked;
    for (const el of document.querySelectorAll('[data-rchart]')) next.report.charts[el.dataset.rchart] = el.checked;
    for (const el of document.querySelectorAll('[data-rschart]')) next.report.sendCharts[el.dataset.rschart] = el.checked;
    return next;
  }

  function clampInt(raw, lo, hi, fallback) {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  async function save() {
    const prev = cfg;
    cfg = collect();
    // enabled は小窓の × とツールバーのアイコンが持つ状態なので、ここでは書かない
    const { enabled, ...rest } = cfg;
    await chrome.storage.local.set(rest);
    // 配置を指定し直したら、手で動かした位置より新しい指定を優先する
    const a = prev.logWindow;
    const b = cfg.logWindow;
    if (a.displayId !== b.displayId || a.anchor !== b.anchor || a.width !== b.width || a.height !== b.height || !b.rememberLast) {
      await forgetLast();
    }
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

  // ------------------------------------------------------------ ログウィンドウ

  /** chrome.system.display の一覧。拡張なしのプレビューでは取れないので空 */
  let displays = [];
  let hasLast = false;

  async function loadDisplays() {
    try {
      displays = (await chrome.system.display.getInfo()) || [];
    } catch (_) {
      displays = [];
    }
    paintLogwin();
  }

  function displayLabel(d, i) {
    const name = d.name && d.name.trim() ? d.name.trim() : `ディスプレイ ${i + 1}`;
    return `${name}（${d.bounds.width}×${d.bounds.height}${d.isPrimary ? '・メイン' : ''}）`;
  }

  function paintLogwin() {
    const lw = cfg.logWindow;
    for (const el of document.querySelectorAll('input[name="lwMode"]')) el.checked = el.value === lw.mode;

    const sel = $('lwDisplay');
    const opts = [['', 'ブラウザと同じディスプレイ'], ...displays.map((d, i) => [d.id, displayLabel(d, i)])];
    // 保存したディスプレイが今は繋がっていなくても、選択は消さずに残す
    if (lw.displayId && !displays.some((d) => d.id === lw.displayId)) opts.push([lw.displayId, '接続されていないディスプレイ']);
    sel.innerHTML = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
    sel.value = lw.displayId;
    $('lwDisplayHint').textContent = displays.length
      ? `${displays.length} 台を検出。指定したディスプレイが外れているときは、ブラウザと同じディスプレイに出す`
      : 'ディスプレイの一覧を取得できませんでした。ブラウザと同じディスプレイに出す';

    $('lwAnchor').value = lw.anchor;
    $('lwWidth').value = lw.width;
    $('lwHeight').value = lw.height;
    $('lwRemember').checked = !!lw.rememberLast;
    $('lwForget').disabled = !hasLast;
    $('lwLastHint').textContent = hasLast
      ? '手で動かした位置を記憶している。ディスプレイ・置き場所・大きさを変えると、記憶した位置は消える'
      : 'ディスプレイ・置き場所・大きさを変えると、記憶した位置は消える';

    // 配置はログウィンドウにだけ効く。⧉ が PiP で、表示先も小窓なら使われない
    const unused = lw.mode === 'pip' && cfg.display === 'hud';
    for (const id of ['lwDisplay', 'lwAnchor', 'lwWidth', 'lwHeight', 'lwRemember']) $(id).disabled = unused;
    paintPreview(unused);
  }

  /** ディスプレイの並びを縮小して描き、ログウィンドウを開く位置を重ねる */
  function paintPreview(unused) {
    const box = $('lwPreview');
    if (!displays.length || unused) {
      box.innerHTML = '';
      return;
    }
    const lw = cfg.logWindow;
    const l = Math.min(...displays.map((d) => d.bounds.left));
    const t = Math.min(...displays.map((d) => d.bounds.top));
    const r = Math.max(...displays.map((d) => d.bounds.left + d.bounds.width));
    const b = Math.max(...displays.map((d) => d.bounds.top + d.bounds.height));
    const H = 130;
    const k = Math.min(H / (b - t), (box.clientWidth || 600) / (r - l));
    const px = (v) => `${Math.round(v * k)}px`;
    const rect = (x) => `left:${px(x.left - l)};top:${px(x.top - t + 12 / k)};width:${px(x.width)};height:${px(x.height)}`;

    // 「ブラウザと同じ」は開くまで決まらないので、このページを開いているディスプレイで描く
    const here = displays.find((d) => {
      const x = window.screenX + window.outerWidth / 2;
      const y = window.screenY + window.outerHeight / 2;
      return x >= d.bounds.left && x < d.bounds.left + d.bounds.width && y >= d.bounds.top && y < d.bounds.top + d.bounds.height;
    });
    const target = displays.find((d) => d.id === lw.displayId) || here || displays.find((d) => d.isPrimary) || displays[0];
    const win = WRA_CONFIG.logwinRect(lw, target);

    box.innerHTML =
      displays
        .map((d, i) => `<div class="disp${d === target ? ' on' : ''}" style="${rect(d.bounds)}">${escapeHtml(displayLabel(d, i))}</div>`)
        .join('') + `<div class="win" style="${rect(win)}" title="ログウィンドウ"></div>`;
  }

  async function refreshLast() {
    hasLast = !!(await chrome.storage.local.get('logwinLast')).logwinLast;
    paintLogwin();
  }

  async function forgetLast() {
    await chrome.storage.local.remove('logwinLast');
    hasLast = false;
  }

  // ------------------------------------------------------------ バージョン

  /*
   * 拡張は自分のファイルを書き換えられないので、更新できるのは Chrome ウェブストア経由で
   * 入れた場合だけ。zip を展開して読み込んだ版（development）はバージョンを出すだけで、
   * 外部へは問い合わせない。確認は Chrome 自身の更新経路（requestUpdateCheck）を使う。
   */
  const UPDATE_EVERY_MS = 6 * 3600 * 1000;
  const VERSION = chrome.runtime.getManifest().version;
  const INSTALL_LABEL = { normal: 'Chrome ウェブストア版', admin: '管理者による配布', development: 'zip 版' };
  let checking = false;

  async function initVersion() {
    const self = await chrome.management?.getSelf?.().catch(() => null);
    const type = self?.installType || 'development';
    const label = INSTALL_LABEL[type] || 'zip 版';
    $('version').textContent = `v${VERSION}（${label}）`;
    // 管理者による配布もストアと同じ更新経路に乗る
    if (type !== 'normal' && type !== 'admin') return;

    $('updateRow').hidden = false;
    $('checkUpdate').addEventListener('click', () => checkUpdate());
    $('applyUpdate').addEventListener('click', applyUpdate);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.updatePending || changes.updateCheck)) paintUpdate();
    });

    const { updateCheck } = await chrome.storage.local.get('updateCheck');
    // 前回の確認から版が変わっていれば（その間に更新が当たった）結果は使えない
    const fresh = updateCheck?.ver === VERSION && Date.now() - updateCheck.at < UPDATE_EVERY_MS;
    if (fresh) paintUpdate();
    else checkUpdate();
  }

  async function checkUpdate() {
    if (checking) return;
    checking = true;
    paintUpdate();
    let r;
    try {
      r = await chrome.runtime.requestUpdateCheck();
    } catch (e) {
      r = { status: 'error' };
    }
    checking = false;
    // 結果は storage に置き、6時間以内に開き直したときは問い合わせない（短時間に何度も呼ぶと throttled になる）
    await chrome.storage.local.set({
      updateCheck: { at: Date.now(), ver: VERSION, status: r.status, latest: r.version || null },
    });
    paintUpdate();
  }

  async function paintUpdate() {
    const { updateCheck: c, updatePending } = await chrome.storage.local.get(['updateCheck', 'updatePending']);
    const newer = (v) => v && WRA_CONFIG.compareVersion(v, VERSION) > 0;
    const state = $('updateState');
    let text;
    let cls = '';
    let ready = false;

    if (newer(updatePending)) {
      // onUpdateAvailable を受けた（ダウンロード済み）ので、再起動すれば当たる
      text = `v${updatePending} があります`;
      cls = 'new';
      ready = true;
    } else if (checking) {
      text = '確認しています…';
    } else if (c?.ver !== VERSION) {
      text = '';
    } else if (c.status === 'update_available' && newer(c.latest)) {
      text = `v${c.latest} をダウンロードしています…`;
      cls = 'new';
    } else if (c.status === 'no_update') {
      text = `最新です（最終確認 ${stamp(c.at)}）`;
      cls = 'ok';
    } else if (c.status === 'throttled') {
      text = '確認が続いたため Chrome に断られました。しばらくしてから試してください';
      cls = 'warn';
    } else {
      text = '確認できませんでした';
      cls = 'warn';
    }

    state.textContent = text;
    state.className = 'update-state ' + cls;
    $('checkUpdate').disabled = checking;
    $('checkUpdate').hidden = ready;
    $('applyUpdate').hidden = !ready;
    $('updateHint').textContent = ready
      ? '再起動すると、開いているページの小窓はページを再読み込みするまで止まる。まだ保存していない直近数秒の履歴は失われる'
      : 'Chrome ウェブストアに新しい版があるかを確認する。設定画面を開いたときにも自動で確認する（6時間に1回まで）';
  }

  function applyUpdate() {
    const msg =
      '拡張を更新して再起動します。\n\n' +
      '開いているページの小窓は、ページを再読み込みするまで止まります。' +
      'まだ保存していない直近数秒の履歴は失われます。\n\nよろしいですか？';
    if (!confirm(msg)) return;
    // 再起動で設定画面も閉じる。保留中の更新はこの再起動で当たる
    chrome.runtime.reload();
  }

  function stamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ------------------------------------------------------------ 保存済みの履歴

  const { listSessions, loadRows, removeSessions, build, dataUrl, filename, localStamp } = WRA_EXPORT;
  let sessions = [];

  async function paintSessions() {
    sessions = await listSessions();
    $('pickAll').checked = false;
    const tbody = document.querySelector('#sessions tbody');
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="desc">まだありません</td></tr>';
      return;
    }
    tbody.innerHTML = sessions
      .map(
        (s, i) => `
      <tr>
        <td><input type="checkbox" data-pick="${i}"></td>
        <td title="${escapeHtml(localStamp(s.start).slice(0, 19))}">${escapeHtml(localStamp(s.start).slice(5, 19))}</td>
        <td title="${escapeHtml(localStamp(s.end).slice(0, 19))}">${escapeHtml(localStamp(s.end).slice(5, 19))}</td>
        <td class="name">${escapeHtml(s.host)}</td>
        <td>${s.rows}</td>
        <td class="ops">
          <button data-sess="${i}" data-op="report-in" ${has(s, 'in') ? '' : 'disabled'} title="受信品質レポート">受信</button>
          <button data-sess="${i}" data-op="report-out" ${has(s, 'out') ? '' : 'disabled'} title="送信品質レポート">送信</button>
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
    if (op === 'report-in' || op === 'report-out') {
      openReports([s], op.slice(7));
      return;
    }
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

  /*
   * レポートは拡張内のページ（src/report/report.html）として開く。
   * セッションIDだけを URL で渡し、中身は向こうで storage から読み直す。
   * 「分ける」ときはセッションごとにタブを開き、それぞれで印刷→PDF保存してもらう。
   */
  function openReports(list, dir) {
    if (!list.length) {
      flash('セッションを選んでください');
      return;
    }
    // その向きのストリームを含まないセッションは外す（記録の無い頁を作らない）
    const usable = list.filter((s) => has(s, dir));
    if (!usable.length) {
      flash(dir === 'out' ? '送信の記録があるセッションがありません' : '受信の記録があるセッションがありません');
      return;
    }
    const groups = cfg.report.mode === 'separate' ? usable.map((s) => [s]) : [usable];
    for (const g of groups) {
      const url =
        chrome.runtime.getURL('src/report/report.html') + `?dir=${dir}&s=` + g.map((s) => encodeURIComponent(s.id)).join(',');
      chrome.tabs.create({ url });
    }
  }

  /** セッションがその向き（in / out）のストリームを含むか。0.6.0 より前の記録は分からないので含むとみなす */
  function has(s, dir) {
    return !s.dirs || s.dirs[dir] === true;
  }

  function picked() {
    return [...document.querySelectorAll('#sessions tbody [data-pick]:checked')]
      .map((el) => sessions[Number(el.dataset.pick)])
      .filter(Boolean)
      // レポートの中では古い順に並べる
      .sort((a, b) => a.start - b.start);
  }

  // ------------------------------------------------------------ 起動

  (async () => {
    buildFields();
    buildThresholds();
    buildReport();
    cfg = merge(await chrome.storage.local.get(KEYS));
    paint();
    initVersion();

    $('toggleEnabled').addEventListener('click', async () => {
      await chrome.storage.local.set({ enabled: !cfg.enabled });
    });
    // アイコンや小窓の × で切り替わったときもボタン表示を追従させる
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.enabled) return;
      cfg.enabled = changes.enabled.newValue === true;
      paint();
    });

    document.addEventListener('change', (e) => {
      // 履歴の選択チェックは設定ではない
      if (e.target.matches('input:not([data-pick]), select')) save();
    });

    await loadDisplays();
    await refreshLast();
    chrome.system?.display?.onDisplayChanged?.addListener(loadDisplays);
    addEventListener('resize', () => paintLogwin());
    $('lwForget').addEventListener('click', async () => {
      await forgetLast();
      paintLogwin();
      flash('記憶した位置を消しました');
    });
    // ⊖ / ⊕ で変わった倍率と、ログウィンドウを動かして記憶した位置を追従させる
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.scale) {
        cfg.scale = merge({ scale: changes.scale.newValue }).scale;
        $('scale').value = cfg.scale;
      }
      if (changes.logwinLast) refreshLast();
    });

    await paintSessions();
    document.querySelector('#sessions').addEventListener('click', onSession);
    $('refreshSessions').addEventListener('click', paintSessions);
    $('reportSelected').addEventListener('click', () => openReports(picked(), 'in'));
    $('reportSelectedSend').addEventListener('click', () => openReports(picked(), 'out'));
    $('pickAll').addEventListener('change', (e) => {
      for (const el of document.querySelectorAll('#sessions tbody [data-pick]')) el.checked = e.target.checked;
    });
    $('clearSessions').addEventListener('click', async () => {
      if (!confirm('保存済みの履歴をすべて削除しますか？')) return;
      await removeSessions(await listSessions());
      await paintSessions();
      flash('すべて削除しました');
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.remove([...KEYS.filter((k) => k !== 'enabled'), 'logwinLast']);
      hasLast = false;
      cfg = structuredClone(DEFAULTS);
      paint();
      flash('既定値に戻しました');
    });
  })();
})();

/*
 * WebRTC Analyzer — 描画層（ISOLATED world / 全フレーム / document_idle）
 *
 * Service Worker から届いたメトリクスを Shadow DOM の小窓に描画し、
 * エクスポート用に履歴を保持する。
 *
 * 全フレームで動かしているのは、フルスクリーン対策のため。
 *   - 通常時   : トップフレームが全フレームぶんを集約して表示する
 *   - 全画面時 : フルスクリーンになった要素を含むフレームだけが表示する
 *     （position: fixed の要素はトップレイヤーの下に潜るので、フルスクリーン要素の
 *       配下に小窓を appendChild し直す必要がある。相手が iframe だと親からは
 *       重ねられないため、その iframe 自身に描かせる）
 */
(() => {
  'use strict';

  const CHANNEL = 'webrtc-analyzer';
  const IS_TOP = window.top === window;
  /** これだけ更新が途絶えたPCは表示から落とす */
  const STALE_MS = 5000;
  const RENDER_MS = 500;
  /*
   * Map の要素数の上限。bridge.js が形を検証しても、ページ側は pc.id を変えながら
   * 送り続けることで別キーを無限に作れる。最終的な保持数はここで頭打ちにする。
   * 実運用では 1タブに数本しか PC は無いので、この値で足りなくなることはない。
   */
  const MAX_PCS = 24;
  const MAX_HISTORY = 96;

  let cfg = structuredClone(WRA_CONFIG.DEFAULTS);

  /** 現在値。PC単位。 key = `${frameId}|${pcId}` */
  const store = new Map();
  /** 履歴。ストリーム単位。 key = `${frameId}|${pcId}|${dir}|${kind}|${rid}` */
  const history = new Map();

  let collapsed = false;
  let pos = null; // ドラッグで動かした位置 {left, top}
  let hud = null;
  let body = null;
  let hostEl = null;
  let menuEl = null;
  let ticking = null;

  // ------------------------------------------------------------- 受信

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__wraChannel !== CHANNEL || msg.type !== 'stats') return;
    // 形の検証は bridge.js で済んでいるが、ここは Service Worker 越しの入口でもある。
    // 落ちると小窓が二度と復帰しないので、最低限の形だけは自分でも確かめる。
    if (!Array.isArray(msg.pcs)) return;

    const now = Date.now();
    const host = msg.host || 'frame';
    const frameId = Number.isInteger(msg.frameId) ? msg.frameId : 0;

    for (const pc of msg.pcs) {
      if (!pc || !Array.isArray(pc.inbound) || !Array.isArray(pc.outbound)) continue;

      const key = `${frameId}|${pc.id}`;
      cap(store, MAX_PCS, key);
      store.set(key, { pc, host, at: now });
      for (const s of [...pc.inbound, ...pc.outbound]) record(frameId, host, pc, s, now);
    }
    if (!ticking) ticking = setInterval(render, RENDER_MS);
  });

  /** key が未登録で満杯なら、いちばん古い項目を捨てて枠を空ける（Map は挿入順） */
  function cap(map, limit, key) {
    if (map.has(key) || map.size < limit) return;
    for (const k of map.keys()) {
      map.delete(k);
      if (map.size < limit) break;
    }
  }

  /** 1サンプルを履歴に積む。PC単位の値（rtt/route/帯域）も行に載せておくとCSVが扱いやすい */
  function record(frameId, host, pc, s, now) {
    const key = `${frameId}|${pc.id}|${s.dir}|${s.kind}|${s.rid ?? ''}`;
    let h = history.get(key);
    if (!h) {
      cap(history, MAX_HISTORY, key);
      h = { meta: { host, pcId: pc.id, dir: s.dir, kind: s.kind, rid: s.rid ?? '' }, samples: [] };
      history.set(key, h);
    }
    h.samples.push({
      t: now,
      w: s.w, h: s.h, fps: s.fps,
      bps: s.bps, targetBps: s.targetBps ?? null,
      jitterMs: s.jitterMs, jbMs: s.jbMs ?? null,
      lossPct: s.lossPct, freezes: s.freezes ?? null,
      // 送信は remote-inbound-rtp 由来のRTT、受信はPC全体のRTTを使う
      rttMs: s.rttMs ?? pc.rttMs ?? null,
      limit: s.limit ?? null, codec: s.codec ?? null,
      state: pc.state, route: pc.route ?? null,
      availOutBps: pc.availOutBps ?? null, availInBps: pc.availInBps ?? null,
    });

    const cutoff = now - cfg.historyMinutes * 60000;
    while (h.samples.length && h.samples[0].t < cutoff) h.samples.shift();
  }

  function streamKey(entryKey, s) {
    return `${entryKey}|${s.dir}|${s.kind}|${s.rid ?? ''}`;
  }

  // ------------------------------------------------------------- 設定

  WRA_CONFIG.load().then((c) => {
    cfg = c;
    if (hud) applyState();
    render();
  });

  chrome.storage.local.get(['collapsed', 'pos']).then((v) => {
    collapsed = v.collapsed === true;
    pos = v.pos || null;
    if (hud) applyState();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.collapsed) collapsed = changes.collapsed.newValue === true;
    if (changes.pos) pos = changes.pos.newValue || null;
    if (WRA_CONFIG.KEYS.some((k) => k in changes)) cfg = await WRA_CONFIG.load();
    if (hud) applyState();
    render();
  });

  document.addEventListener('fullscreenchange', () => render());

  // ------------------------------------------------------------- 表示判定

  function fullscreenEl() {
    return document.fullscreenElement || null;
  }

  function shouldShow() {
    if (!cfg.enabled) return false;

    const fs = fullscreenEl();
    // <video> や <iframe> は子要素を描画しないので、その上には重ねられない。
    // iframe が全画面なら、その iframe 自身のオーバーレイが担当する。
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) return false;
    // 子フレームは全画面のときだけ出る（通常時はトップの小窓と二重になる）
    if (!IS_TOP && !fs) return false;

    return live().length > 0;
  }

  function live() {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at > STALE_MS) store.delete(k);
    return [...store.entries()];
  }

  // ------------------------------------------------------------- DOM 構築

  function build() {
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-wra', '');
    // ページのCSSが html > div などで我々のホストを掴んで transform を掛けると
    // 子の position: fixed が壊れる。インラインの !important で封じる。
    hostEl.style.cssText = 'all: initial !important;';

    // open にしておくと DevTools のコンソールから
    // document.querySelector('[data-wra]').shadowRoot で中身を触れる。
    // closed にしてもページ側はホスト要素ごと消せるので、防御としては大差ない。
    const root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WRA_STYLE;

    hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <header>
        <span class="title">WebRTC Analyzer</span>
        <span class="alarm" hidden></span>
        <button data-act="export"   title="エクスポート">⤓</button>
        <button data-act="options"  title="設定">⚙</button>
        <button data-act="collapse" title="折りたたみ">–</button>
        <button data-act="close"    title="非表示（ツールバーのアイコンで戻せます）">×</button>
      </header>
      <div class="menu" hidden>
        <button data-act="csv">CSV で保存</button>
        <button data-act="json">JSON で保存</button>
        <button data-act="clear">履歴をクリア</button>
        <div class="menu-note"></div>
      </div>
      <div class="body"></div>`;

    body = hud.querySelector('.body');
    menuEl = hud.querySelector('.menu');

    hud.addEventListener('click', onClick);
    enableDrag(hud.querySelector('header'));
    // 小窓の外をクリックしたらメニューを閉じる
    document.addEventListener('click', (e) => {
      if (!menuEl.hidden && !e.composedPath().includes(hud)) menuEl.hidden = true;
    });

    root.append(style, hud);
    applyState();
  }

  function onClick(e) {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'collapse') chrome.storage.local.set({ collapsed: !collapsed });
    else if (act === 'close') chrome.storage.local.set({ enabled: false });
    else if (act === 'options') chrome.runtime.sendMessage({ __wraChannel: CHANNEL, type: 'open-options' });
    else if (act === 'export') menuEl.hidden = !menuEl.hidden;
    else if (act === 'csv') exportFile('csv');
    else if (act === 'json') exportFile('json');
    else if (act === 'clear') {
      history.clear();
      note('履歴をクリアしました');
    }
  }

  function note(text) {
    const el = menuEl.querySelector('.menu-note');
    el.textContent = text;
    clearTimeout(note.t);
    note.t = setTimeout(() => (el.textContent = ''), 4000);
  }

  function applyState() {
    hud.classList.toggle('collapsed', collapsed);
    hud.classList.toggle('spark', !!cfg.sparkline);
    if (collapsed) menuEl.hidden = true;
    if (pos) {
      hud.style.left = clamp(pos.left, 0, Math.max(0, innerWidth - 120)) + 'px';
      hud.style.top = clamp(pos.top, 0, Math.max(0, innerHeight - 28)) + 'px';
      hud.style.right = 'auto';
    } else {
      hud.style.left = 'auto';
      hud.style.right = '12px';
      hud.style.top = '12px';
    }
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function enableDrag(handle) {
    let dx = 0;
    let dy = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = hud.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp, { once: true });
      e.preventDefault();
    });

    function onMove(e) {
      pos = { left: e.clientX - dx, top: e.clientY - dy };
      applyState();
    }
    function onUp(e) {
      handle.removeEventListener('pointermove', onMove);
      handle.releasePointerCapture(e.pointerId);
      if (pos) chrome.storage.local.set({ pos });
    }
  }

  // ------------------------------------------------------------- 描画

  function render() {
    const show = shouldShow();

    if (!show) {
      if (hostEl && hostEl.parentNode) hostEl.remove();
      if (!store.size && ticking) {
        clearInterval(ticking);
        ticking = null;
      }
      return;
    }

    if (!hostEl) build();

    // フルスクリーン要素があればその配下へ移す（トップレイヤーに入れるため）
    const parent = fullscreenEl() || document.documentElement;
    if (hostEl.parentNode !== parent) parent.appendChild(hostEl);

    const entries = live().sort(
      (a, b) => a[1].host.localeCompare(b[1].host) || a[1].pc.id.localeCompare(b[1].pc.id)
    );

    let alarms = 0;
    const html = entries.map(([key, entry]) => {
      const r = renderPc(key, entry);
      alarms += r.crit;
      return r.html;
    });

    body.innerHTML = html.join('') || '<div class="empty">no active connection</div>';

    const alarm = hud.querySelector('.alarm');
    alarm.hidden = !(cfg.alerts && alarms > 0);
    alarm.textContent = alarms > 0 ? `⚠ ${alarms}` : '';
  }

  function renderPc(key, entry) {
    const pc = entry.pc;
    const state = String(pc.state || 'unknown');
    let crit = 0;

    const rttLv = level('rttMs', pc.rttMs);
    if (rttLv === 'crit') crit++;

    const conn = metrics(null, [
      { key: 'route', label: 'route', value: pc.route ? pc.route + (pc.protocol ? ` (${pc.protocol})` : '') : null },
      { key: 'rtt', label: 'rtt', value: ms(pc.rttMs), level: rttLv, field: 'rttMs' },
      { key: 'avail', label: 'avail↑', value: bps(pc.availOutBps), field: 'availOutBps' },
      { key: 'avail', label: 'avail↓', value: bps(pc.availInBps), field: 'availInBps' },
    ], firstSamples(key));

    const streams = [...pc.inbound, ...pc.outbound].map((s) => {
      const r = renderStream(key, s);
      crit += r.crit;
      return r.html;
    });

    return {
      crit,
      html: `<div class="pc">
        <div class="pc-head">
          <span class="src">${esc(entry.host)} · ${esc(pc.id)}</span>
          <span class="state state-${esc(state)}">${esc(state)}</span>
        </div>
        ${conn}
        ${streams.join('')}
      </div>`,
    };
  }

  function renderStream(entryKey, s) {
    const h = history.get(streamKey(entryKey, s));
    const samples = h ? h.samples : [];

    const jitterLv = level('jitterMs', s.jitterMs);
    const bufferLv = level('bufferMs', s.jbMs);
    const lossLv = level('lossPct', s.lossPct);
    const rttLv = level('rttMs', s.rttMs);
    const freezeLv = level('freeze', freezeDelta(samples));
    const crit = [jitterLv, bufferLv, lossLv, rttLv, freezeLv].filter((l) => l === 'crit').length;

    const items =
      s.dir === 'in'
        ? [
            { key: 'bitrate', label: 'bitrate', value: bps(s.bps), field: 'bps' },
            { key: 'jitter', label: 'jitter', value: ms(s.jitterMs), level: jitterLv, field: 'jitterMs' },
            { key: 'loss', label: 'loss', value: pct(s.lossPct), level: lossLv, field: 'lossPct' },
            { key: 'buffer', label: 'buffer', value: ms(s.jbMs), level: bufferLv, field: 'jbMs' },
            { key: 'freeze', label: 'freeze', value: s.freezes != null ? String(s.freezes) : null, level: freezeLv, field: 'freezes' },
          ]
        : [
            { key: 'bitrate', label: 'bitrate', value: bps(s.bps), field: 'bps' },
            { key: 'target', label: 'target', value: bps(s.targetBps), field: 'targetBps' },
            { key: 'rtt', label: 'rtt', value: ms(s.rttMs), level: rttLv, field: 'rttMs' },
            { key: 'jitter', label: 'jitter', value: ms(s.jitterMs), level: jitterLv, field: 'jitterMs' },
            { key: 'loss', label: 'loss', value: pct(s.lossPct), level: lossLv, field: 'lossPct' },
            // 送信品質が落ちた原因。ここが cpu / bandwidth なら送信側がボトルネック
            { key: 'limit', label: 'limit', value: s.limit, level: s.limit ? 'warn' : '' },
            { key: 'src', label: 'src', value: s.srcW && s.w && s.srcW !== s.w ? `${s.srcW}×${s.srcH}` : null, level: 'warn' },
          ];

    return {
      crit,
      html: `<div class="stream">
        ${streamHead(s.dir === 'in' ? '↓' : '↑', s.dir, s)}
        ${metrics(s, items, samples)}
      </div>`,
    };
  }

  function streamHead(arrow, dir, s) {
    const res = cfg.fields.resolution && s.w && s.h ? `${s.w}×${s.h}` : null;
    const f = cfg.fields.fps && s.fps != null ? `${s.fps < 10 ? s.fps.toFixed(1) : Math.round(s.fps)}fps` : null;
    // 音声には解像度もFPSも無い。ビットレートは下の一覧に出るので見出しは空でよい。
    const main = [res, f].filter(Boolean).join(' ');
    const kind = s.rid ? `${s.kind}·${s.rid}` : s.kind;
    return `<div class="stream-head">
      <span class="arrow ${dir}">${arrow}</span>
      <span class="kind">${esc(kind)}</span>
      <span class="head-main">${esc(main)}</span>
      <span class="codec">${cfg.fields.codec ? esc(codec(s.codec)) : ''}</span>
    </div>`;
  }

  /**
   * 値の一覧を描く。スパークラインONなら 1列（ラベル・折れ線・値）、
   * OFFなら従来どおり 2列に詰める。
   */
  function metrics(_stream, items, samples) {
    const shown = items.filter((i) => i.value != null && i.value !== '' && cfg.fields[i.key] !== false);
    if (!shown.length) return '';

    if (!cfg.sparkline) {
      const cells = shown
        .map((i) => `<div><span class="k">${esc(i.label)}</span><span class="v ${i.level || ''}">${esc(i.value)}</span></div>`)
        .join('');
      return `<div class="kv">${cells}</div>`;
    }

    const rows = shown
      .map(
        (i) =>
          `<div><span class="k">${esc(i.label)}</span>` +
          `<span class="sp">${i.field ? sparkline(samples, i.field) : ''}</span>` +
          `<span class="v ${i.level || ''}">${esc(i.value)}</span></div>`
      )
      .join('');
    return `<div class="kvs">${rows}</div>`;
  }

  /** PC単位の値（rtt/帯域）用に、そのPCのどれか1本のストリーム履歴を借りる */
  function firstSamples(entryKey) {
    for (const [k, h] of history) if (k.startsWith(entryKey + '|')) return h.samples;
    return [];
  }

  // ------------------------------------------------------------- スパークライン

  const SPARK_W = 84;
  const SPARK_H = 13;

  function sparkline(samples, field) {
    const from = Date.now() - cfg.sparkSeconds * 1000;
    const pts = [];
    for (const s of samples) if (s.t >= from && s[field] != null) pts.push(s);
    if (pts.length < 2) return '';

    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      const v = p[field];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // 平坦なら中央に一本引く（0除算も避ける）
    if (max === min) {
      min -= 0.5;
      max += 0.5;
    }

    const t0 = pts[0].t;
    const span = Math.max(1, pts[pts.length - 1].t - t0);
    const pad = 1;
    const d = pts
      .map((p) => {
        const x = pad + ((p.t - t0) / span) * (SPARK_W - pad * 2);
        const y = SPARK_H - pad - ((p[field] - min) / (max - min)) * (SPARK_H - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}"><polyline points="${d}"/></svg>`;
  }

  /** 直近1サンプルでのフリーズ増分。累積値のままではアラートに使えない */
  function freezeDelta(samples) {
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1].freezes;
      const b = samples[i].freezes;
      if (a != null && b != null) return Math.max(0, b - a);
    }
    return null;
  }

  function level(metric, v) {
    if (!cfg.alerts || v == null) return '';
    const t = cfg.thresholds[metric];
    if (!t) return '';
    if (t.crit != null && v >= t.crit) return 'crit';
    if (t.warn != null && v >= t.warn) return 'warn';
    return '';
  }

  // ------------------------------------------------------------- エクスポート

  const COLS = [
    ['time_local', (m, s) => localStamp(s.t)],
    ['time_iso', (m, s) => new Date(s.t).toISOString()],
    ['host', (m) => m.host],
    ['pc', (m) => m.pcId],
    ['direction', (m) => (m.dir === 'in' ? 'inbound' : 'outbound')],
    ['kind', (m) => m.kind],
    ['rid', (m) => m.rid],
    ['codec', (m, s) => s.codec],
    ['width', (m, s) => s.w],
    ['height', (m, s) => s.h],
    ['fps', (m, s) => round(s.fps, 1)],
    ['bitrate_bps', (m, s) => round(s.bps, 0)],
    ['target_bps', (m, s) => round(s.targetBps, 0)],
    ['jitter_ms', (m, s) => round(s.jitterMs, 2)],
    ['jitter_buffer_ms', (m, s) => round(s.jbMs, 1)],
    ['loss_pct', (m, s) => round(s.lossPct, 3)],
    ['freeze_count', (m, s) => s.freezes],
    ['rtt_ms', (m, s) => round(s.rttMs, 2)],
    ['quality_limitation', (m, s) => s.limit],
    ['avail_out_bps', (m, s) => round(s.availOutBps, 0)],
    ['avail_in_bps', (m, s) => round(s.availInBps, 0)],
    ['route', (m, s) => s.route],
    ['state', (m, s) => s.state],
  ];

  function allRows() {
    const rows = [];
    for (const h of history.values()) for (const s of h.samples) rows.push({ meta: h.meta, s });
    rows.sort((a, b) => a.s.t - b.s.t);
    return rows;
  }

  function exportFile(kind) {
    const rows = allRows();
    if (!rows.length) {
      note('まだ履歴がありません');
      return;
    }

    let text;
    let mime;
    if (kind === 'csv') {
      const lines = [COLS.map((c) => c[0]).join(',')];
      for (const { meta, s } of rows) lines.push(COLS.map((c) => csvCell(c[1](meta, s))).join(','));
      // BOM(U+FEFF) + CRLF。Excel で開いたときに文字化けせず、行も崩れない。
      text = '\uFEFF' + lines.join('\r\n');
      mime = 'text/csv;charset=utf-8';
    } else {
      const out = rows.map(({ meta, s }) => Object.fromEntries(COLS.map((c) => [c[0], c[1](meta, s) ?? null])));
      text = JSON.stringify(out, null, 1);
      mime = 'application/json';
    }

    /*
     * ページの DOM に <a href="blob:..."> を挿してクリックする方法は使わない。
     * blob URL はページの origin で発行されるので、ページ側が MutationObserver で
     * href を拾えば、収集した履歴をそのまま読み取れてしまう。計測対象のサイト自身に
     * 品質ログを渡すことになる。Service Worker の chrome.downloads に投げれば、
     * ページ側からは保存の事実すら見えない。
     */
    chrome.runtime
      .sendMessage({
        __wraChannel: CHANNEL,
        type: 'download',
        url: dataUrl(text, mime),
        filename: `webrtc-${fileStamp()}.${kind}`,
      })
      .then((res) => {
        if (res && res.ok) note(`${rows.length} 行を書き出しました`);
        else note(`保存できませんでした: ${res?.error ?? '不明なエラー'}`);
      })
      .catch(() => note('保存できませんでした。拡張を再読み込みしてください'));
  }

  /** UTF-8 の文字列を data: URL にする。chrome.downloads は data: を受け付ける */
  function dataUrl(text, mime) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    // 一度に渡すと引数が多すぎて RangeError になるので分割して詰める
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function round(v, digits) {
    return typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(digits) : null;
  }

  function pad(n, w = 2) {
    return String(n).padStart(w, '0');
  }

  /** Excel がそのまま日時として解釈できる形式 */
  function localStamp(t) {
    const d = new Date(t);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
  }

  function fileStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // ------------------------------------------------------------- 整形

  function bps(v) {
    if (v == null) return null;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
    if (v >= 1e3) return Math.round(v / 1e3) + ' kbps';
    return Math.round(v) + ' bps';
  }

  function ms(v) {
    if (v == null) return null;
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ms';
  }

  function pct(v) {
    if (v == null) return null;
    return v.toFixed(2) + ' %';
  }

  function codec(mime) {
    return mime ? String(mime).replace(/^(video|audio)\//, '') : '';
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
  }
})();

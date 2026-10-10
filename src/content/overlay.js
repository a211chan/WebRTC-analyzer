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
  /** 受信が途切れている間の描画間隔。値は動かないので落としてよい */
  const IDLE_MS = 5000;
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
  let tickMs = 0;
  /** Document Picture-in-Picture で開いた別ウィンドウ。null なら通常のページ内表示 */
  let pipWin = null;
  const CAN_PIP = IS_TOP && 'documentPictureInPicture' in window;

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
    tick(RENDER_MS);
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
      nack: s.nack ?? null, pli: s.pli ?? null, rtx: s.rtx ?? null,
      dropped: s.dropped ?? null, freezeMs: s.freezeMs ?? null,
      fir: s.fir ?? null, keyFrames: s.keyFrames ?? null, discarded: s.discarded ?? null,
      pauses: s.pauses ?? null, pauseMs: s.pauseMs ?? null,
      decodeMs: s.decodeMs ?? null, encodeMs: s.encodeMs ?? null,
      pktRecv: s.pktRecv ?? null, pktLost: s.pktLost ?? null,
      concealPct: s.concealPct ?? null, concealEvents: s.concealEvents ?? null,
      srcW: s.srcW ?? null, srcH: s.srcH ?? null, srcFps: s.srcFps ?? null, audioLevel: s.audioLevel ?? null,
      limitCpuMs: s.limitCpuMs ?? null, limitBwMs: s.limitBwMs ?? null, resChanges: s.resChanges ?? null,
      // 再接続や SSRC 変更の検出用。履歴のキーには含めず、サンプルに載せる
      ssrc: s.ssrc ?? null, mid: s.mid ?? null,
      // 送信は remote-inbound-rtp 由来のRTT、受信はPC全体のRTTを使う
      rttMs: s.rttMs ?? pc.rttMs ?? null,
      limit: s.limit ?? null, codec: s.codec ?? null,
      state: pc.state, route: pc.route ?? null, pairChanges: pc.pairChanges ?? null,
      /*
       * タブが表示されていたか。非表示のタブはブラウザが描画を間引くので、
       * 受信側の fps・dropped はその間の値を品質評価に使えない。
       */
      visible: !document.hidden,
      /*
       * availableOutgoingBitrate は candidate-pair の値で、送信が1本も無くても
       * 既定値（Chrome では 300kbps）が入ってくる。受信専用の接続でこれを載せると
       * 「送信できる帯域」を測ったように見えて誤読を招くので、送信が無ければ捨てる。
       * 受信側も同様。availableIncomingBitrate は Chrome がほぼ返さないため、
       * 多くの場合は元から null になる。
       */
      availOutBps: pc.outbound.length ? (pc.availOutBps ?? null) : null,
      availInBps: pc.inbound.length ? (pc.availInBps ?? null) : null,
    });

    const cutoff = now - cfg.historyMinutes * 60000;
    while (h.samples.length && h.samples[0].t < cutoff) h.samples.shift();

    if (IS_TOP && cfg.persist) {
      persist.metas[key] = h.meta;
      persist.rows.push([key, compact(h.samples[h.samples.length - 1])]);
      if (!persist.timer) persist.timer = setTimeout(flush, PERSIST_MS);
    }
  }

  /**
   * 保存用に null の項目を落とす。送信・受信・映像・音声で使う項目が違うため、1行の半分以上は
   * null になる。読み出し側（export.js / レポート）は欠けた項目を null と同じに扱う。
   */
  function compact(sample) {
    const out = {};
    for (const k in sample) if (sample[k] != null) out[k] = sample[k];
    return out;
  }

  // ------------------------------------------------------------- 永続化

  /*
   * 履歴はメモリ上にもあるが、ページを離れると消える。障害に気づいた時点で
   * 再生し直していても事後に追えるよう、トップフレームだけが一定間隔で
   * chrome.storage.local へ差分を書き足す（子フレームのぶんもトップに集約済み）。
   * 1ページ = 1セッション。一覧とエクスポートは設定画面から行う。
   */
  const PERSIST_MS = 10000;
  const persist = { session: null, metas: {}, rows: [], timer: null };

  function flush() {
    persist.timer = null;
    if (!persist.rows.length) return;
    if (!persist.session) {
      persist.session = {
        id: WRA_EXPORT.newSessionId(),
        host: location.host || 'page',
        start: Date.now(),
        end: 0,
        rows: 0,
        chunks: 0,
        // レポートの「計測条件」用。URL のパスは載せない（PRIVACY.md）
        browser: browserLabel(),
        version: chrome.runtime.getManifest?.().version ?? null,
        intervalMs: cfg.intervalMs,
      };
      // 新しいセッションを始めるついでに、保持期限を過ぎたものを掃除する
      WRA_EXPORT.prune(cfg.persistHours).catch(() => {});
    }
    const { metas, rows } = persist;
    persist.metas = {};
    persist.rows = [];
    WRA_EXPORT.writeChunk(persist.session, metas, rows).catch(() => {
      // 拡張の再読み込み直後など。取りこぼしは許容する（メモリ上の履歴は残っている）
    });
  }

  /** 「Chrome 141 / Windows」の形。userAgentData が無い環境は UA 文字列から拾う */
  function browserLabel() {
    const ua = navigator.userAgentData;
    const brand = ua?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)) || ua?.brands?.find((b) => /Chromium/i.test(b.brand));
    const name = brand ? `${brand.brand} ${brand.version}` : (navigator.userAgent.match(/(Edg|Chrome)\/(\d+)/) || []).slice(1).join(' ') || null;
    const os = ua?.platform || null;
    return [name, os].filter(Boolean).join(' / ') || null;
  }

  // 離脱時に残りを書く。完了を待てないので最善努力
  addEventListener('pagehide', flush);

  function streamKey(entryKey, s) {
    return `${entryKey}|${s.dir}|${s.kind}|${s.rid ?? ''}`;
  }

  // ------------------------------------------------------------- 設定

  WRA_CONFIG.load().then((c) => {
    cfg = c;
    if (hud) applyState();
    render();
  });

  chrome.storage.local.get('collapsed').then((v) => {
    collapsed = v.collapsed === true;
    if (hud) applyState();
  });

  /*
   * 小窓の位置は storage.local に置かない。local は全タブ共通なので、片方のタブで
   * 動かすと storage.onChanged が他のタブにも飛び、開いている小窓がいっせいに
   * 同じ場所へ移動してしまう。位置は Service Worker がタブ単位で覚える。
   */
  chrome.runtime
    .sendMessage({ __wraChannel: CHANNEL, type: 'ui-get' })
    .then((v) => {
      pos = v?.pos || null;
      if (hud) applyState();
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.collapsed) collapsed = changes.collapsed.newValue === true;
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
    // 別ウィンドウに出しているあいだはページの全画面状態に左右されない
    if (pipWin) return live().length > 0 || history.size > 0;

    const fs = fullscreenEl();
    // <video> や <iframe> は子要素を描画しないので、その上には重ねられない。
    // iframe が全画面なら、その iframe 自身のオーバーレイが担当する。
    // <video> の場合はどのフレームからも重ねられないので、⧉ で別ウィンドウに出してもらう。
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) return false;
    // 子フレームは全画面のときだけ出る（通常時はトップの小窓と二重になる）
    if (!IS_TOP && !fs) return false;

    // 配信が止まっても、履歴が残っているうちは閉じない。止まった瞬間に消えると
    // 肝心の「落ちたときのログ」を保存できないまま小窓が無くなってしまう。
    return live().length > 0 || history.size > 0;
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
        ${CAN_PIP ? '<button data-act="pip" title="別ウィンドウに出す（動画を直接全画面にするプレーヤーでも見える）">⧉</button>' : ''}
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
    else if (act === 'pip') togglePip();
    else if (act === 'csv') exportFile('csv');
    else if (act === 'json') exportFile('json');
    else if (act === 'clear') {
      history.clear();
      note('履歴をクリアしました（保存済みの履歴は設定画面から消せます）');
    }
  }

  function note(text) {
    const el = menuEl.querySelector('.menu-note');
    el.textContent = text;
    clearTimeout(note.t);
    note.t = setTimeout(() => (el.textContent = ''), 4000);
  }

  /*
   * Document Picture-in-Picture。<video> 要素そのものが全画面になると、
   * video は子要素を描画しないためページ内のどこにも小窓を重ねられない。
   * 常に最前面に出る別ウィンドウへ小窓ごと移しておけば、全画面の上にも見える。
   * requestWindow() はユーザー操作起点でしか呼べないので、ボタンで開く。
   */
  async function togglePip() {
    if (pipWin) {
      pipWin.close();
      return;
    }
    try {
      const w = await documentPictureInPicture.requestWindow({ width: 320, height: 420 });
      w.document.title = 'WebRTC Analyzer';
      w.document.body.style.cssText = 'margin:0;background:#121418;';
      // 閉じられたらページ内の表示に戻す
      w.addEventListener('pagehide', () => {
        pipWin = null;
        hud.classList.remove('pip');
        applyState();
        render();
      });
      pipWin = w;
      hud.classList.add('pip');
      menuEl.hidden = true;
      render();
    } catch (_) {
      note('別ウィンドウを開けませんでした');
    }
  }

  function applyState() {
    hud.classList.toggle('collapsed', collapsed);
    hud.classList.toggle('spark', !!cfg.sparkline);
    if (collapsed) menuEl.hidden = true;
    if (pipWin) {
      // 別ウィンドウ内ではウィンドウ自体を動かすので、位置指定は使わない
      hud.style.left = hud.style.top = hud.style.right = '';
    } else if (pos) {
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
      if (e.target.tagName === 'BUTTON' || pipWin) return;
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
      if (pos) chrome.runtime.sendMessage({ __wraChannel: CHANNEL, type: 'ui-set', pos }).catch(() => {});
    }
  }

  // ------------------------------------------------------------- 描画

  function render() {
    const show = shouldShow();

    if (!show) {
      if (hostEl && hostEl.parentNode) hostEl.remove();
      if (!store.size) idle();
      return;
    }

    if (!hostEl) build();

    // フルスクリーン要素があればその配下へ移す（トップレイヤーに入れるため）
    const parent = pipWin ? pipWin.document.body : fullscreenEl() || document.documentElement;
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

    body.innerHTML = html.join('') || stopped();

    const alarm = hud.querySelector('.alarm');
    alarm.hidden = !(cfg.alerts && alarms > 0);
    alarm.textContent = alarms > 0 ? `⚠ ${alarms}` : '';

    // 受信が途切れたら描画を緩める。小窓自体は履歴を保存できるよう残したまま。
    if (!store.size) idle();
  }

  function tick(ms) {
    if (tickMs === ms) return;
    if (ticking) clearInterval(ticking);
    tickMs = ms;
    ticking = ms ? setInterval(render, ms) : null;
  }

  /*
   * 受信が止まったあとの後始末。履歴が保持期間を過ぎて空になったら、そこで
   * ようやく小窓を閉じてタイマーも止める。保存する時間は十分に残る。
   */
  function idle() {
    prune();
    tick(history.size ? IDLE_MS : 0);
  }

  function prune() {
    const cutoff = Date.now() - cfg.historyMinutes * 60000;
    for (const [k, h] of history) {
      while (h.samples.length && h.samples[0].t < cutoff) h.samples.shift();
      if (!h.samples.length) history.delete(k);
    }
  }

  function stopped() {
    if (!history.size) return '<div class="empty">no active connection</div>';
    return '<div class="empty">配信が停止しました。<br>⤓ から、または設定画面の「保存済みの履歴」から書き出せます。</div>';
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
      { key: 'avail', label: 'avail↑', value: pc.outbound.length ? bps(pc.availOutBps) : null, field: 'availOutBps' },
      { key: 'avail', label: 'avail↓', value: pc.inbound.length ? bps(pc.availInBps) : null, field: 'availInBps' },
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
    // fps は受信映像だけ判定する。送信側の fps は送り手の設定次第で、低くても劣化とは限らない
    const fpsLv = s.dir === 'in' && s.kind === 'video' ? level('fps', s.fps) : '';
    const concealLv = level('concealPct', s.concealPct);
    const crit = [jitterLv, bufferLv, lossLv, rttLv, freezeLv, fpsLv, concealLv].filter((l) => l === 'crit').length;

    const items =
      s.dir === 'in'
        ? [
            { key: 'bitrate', label: 'bitrate', value: bps(s.bps), field: 'bps' },
            { key: 'jitter', label: 'jitter', value: ms(s.jitterMs), level: jitterLv, field: 'jitterMs' },
            { key: 'loss', label: 'loss', value: pct(s.lossPct), level: lossLv, field: 'lossPct' },
            { key: 'buffer', label: 'buffer', value: ms(s.jbMs), level: bufferLv, field: 'jbMs' },
            { key: 'freeze', label: 'freeze', value: s.freezes != null ? String(s.freezes) : null, level: freezeLv, field: 'freezes' },
            { key: 'conceal', label: 'conceal', value: pct(s.concealPct), level: concealLv, field: 'concealPct' },
            // 以下は直近1サンプルでの増分。loss 0% なのに固まる原因の切り分けに使う
            { key: 'freezeDur', label: 'frz time', value: ms(s.freezeMs), level: s.freezeMs > 0 ? 'warn' : '', field: 'freezeMs' },
            { key: 'nack', label: 'nack', value: count(s.nack), field: 'nack' },
            { key: 'rtx', label: 'rtx', value: count(s.rtx), field: 'rtx' },
            { key: 'pli', label: 'pli', value: count(s.pli), level: s.pli > 0 ? 'warn' : '', field: 'pli' },
            { key: 'dropped', label: 'dropped', value: count(s.dropped), level: s.dropped > 0 ? 'warn' : '', field: 'dropped' },
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
        ${streamHead(s.dir === 'in' ? '↓' : '↑', s.dir, s, fpsLv)}
        ${metrics(s, items, samples)}
      </div>`,
    };
  }

  function streamHead(arrow, dir, s, fpsLv) {
    const res = cfg.fields.resolution && s.w && s.h ? esc(`${s.w}×${s.h}`) : null;
    const f =
      cfg.fields.fps && s.fps != null
        ? `<span class="v ${fpsLv || ''}">${esc(`${s.fps < 10 ? s.fps.toFixed(1) : Math.round(s.fps)}fps`)}</span>`
        : null;
    // 音声には解像度もFPSも無い。ビットレートは下の一覧に出るので見出しは空でよい。
    const main = [res, f].filter(Boolean).join(' ');
    const kind = s.rid ? `${s.kind}·${s.rid}` : s.kind;
    return `<div class="stream-head">
      <span class="arrow ${dir}">${arrow}</span>
      <span class="kind">${esc(kind)}</span>
      <span class="head-main">${main}</span>
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
    // fps のように「低いほど悪い」指標は dir: 'below'
    const hit = (lim) => lim != null && (t.dir === 'below' ? v <= lim : v >= lim);
    if (hit(t.crit)) return 'crit';
    if (hit(t.warn)) return 'warn';
    return '';
  }

  // ------------------------------------------------------------- エクスポート

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

    const { text, mime } = WRA_EXPORT.build(kind, rows);

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
        url: WRA_EXPORT.dataUrl(text, mime),
        filename: WRA_EXPORT.filename(kind),
      })
      .then((res) => {
        if (res && res.ok) note(`${rows.length} 行を書き出しました`);
        else note(`保存できませんでした: ${res?.error ?? '不明なエラー'}`);
      })
      .catch(() => note('保存できませんでした。拡張を再読み込みしてください'));
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

  function count(v) {
    return v == null ? null : String(v);
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

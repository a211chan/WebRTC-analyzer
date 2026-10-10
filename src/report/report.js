/*
 * WebRTC Analyzer — 受信品質レポート
 *
 * 保存済みの履歴（wra:s: / wra:c:）から、受信した映像・音声の品質を評価する印刷用HTMLを組み立てる。
 * PDF化はブラウザの印刷（「PDFに保存」）に任せるので、ライブラリもフォントも同梱しない。
 *
 * URL: report.html?s=<sessionId>,<sessionId>...
 *   複数あれば1冊にまとめる（冒頭に比較表）。分けるかどうかは設定画面が決め、
 *   分けるときはセッションごとにこのページを開く。
 *
 * 評価の対象は受信（inbound）だけ。送信したストリームの行は読み飛ばす。
 *
 * 集計の単位は「視聴」。1セッション（1ページ）の中で、時間の重ならない PeerConnection は
 * 再接続とみなして1つの視聴につなぐ。同時に張られていた PeerConnection は別の視聴として扱う。
 * 1つの PeerConnection に同じ種類の受信が複数ある（会議など）ときは、サンプル数の
 * 最も多いもの（mid 単位）を評価し、ほかは件数だけ計測条件に出す。
 *
 * 判定は設定画面のしきい値（cfg.thresholds）だけを使う。レポート専用の基準は持たない。
 *   - 連続値（ジッターバッファ・ロス率・fps・音声の補間率・RTT）
 *       「高いほど悪い」指標は上位5%値、「低いほど悪い」指標（fps）は下位5%値をしきい値と比べる。
 *       一瞬の跳ねで全体を不良にしないため。超過していた時間の割合も併記する。
 *       受信開始前（最初に connected でビットレートが出るまで）のサンプルは除く。
 *   - 回数（フリーズ）
 *       期間中の合計回数をしきい値と比べる。タブが非表示の間は数えない。
 *   総合判定は、重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外は「良好」。
 */
(() => {
  'use strict';

  const { merge, KEYS } = WRA_CONFIG;
  const { listSessions, loadRows, localStamp, fileStamp } = WRA_EXPORT;

  const $ = (id) => document.getElementById(id);

  /** 判定の段階 */
  const LV = { ok: 0, warn: 1, crit: 2 };
  const VERDICT = [
    { key: 'ok', label: '良好' },
    { key: 'warn', label: '注意' },
    { key: 'crit', label: '不良' },
  ];

  /** 連続値の指標。key は cfg.thresholds と p.series のキー */
  const CONT = [
    { key: 'bufferMs', label: 'ジッターバッファ遅延', unit: 'ms', digits: 0 },
    { key: 'lossPct', label: 'パケットロス率', unit: '%', digits: 2 },
    { key: 'fps', label: 'フレームレート（映像）', unit: 'fps', digits: 1 },
    { key: 'concealPct', label: '音声の補間率', unit: '%', digits: 2 },
    { key: 'rttMs', label: '往復遅延（RTT）', unit: 'ms', digits: 0 },
  ];

  // ------------------------------------------------------------ 起動

  (async () => {
    $('print').addEventListener('click', () => window.print());
    const root = $('report');
    try {
      const cfg = merge(await chrome.storage.local.get(KEYS));
      const ids = (new URLSearchParams(location.search).get('s') || '').split(',').filter(Boolean);
      const all = await listSessions();
      const picked = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean).sort((a, b) => a.start - b.start);
      if (!picked.length) {
        root.innerHTML = '<p class="loading">対象のセッションが見つかりません。保存期間を過ぎて削除された可能性があります。</p>';
        return;
      }

      const sessions = [];
      for (const s of picked) sessions.push({ session: s, ...analyzeSession(await loadRows(s), cfg) });

      root.innerHTML = render(sessions, cfg);
      // 「PDFに保存」の既定のファイル名になる
      document.title = `webrtc-report-${fileStamp(picked[0].start)}${picked.length > 1 ? `-${picked.length}` : ''}`;
    } catch (e) {
      root.innerHTML = `<p class="loading">レポートを作れませんでした: ${esc(e && e.message)}</p>`;
    }
  })();

  // ------------------------------------------------------------ 集計

  /** セッション内の受信を PeerConnection ごとにまとめ、再接続をつないで「視聴」に分ける */
  function analyzeSession(rows, cfg) {
    const pcs = new Map();
    let hasOut = false;
    for (const { meta, s } of rows) {
      if (meta.dir !== 'in') {
        hasOut = true;
        continue;
      }
      if (meta.kind !== 'video' && meta.kind !== 'audio') continue;
      const k = `${meta.host}|${meta.pcId}`;
      let g = pcs.get(k);
      if (!g) pcs.set(k, (g = { pcId: meta.pcId, host: meta.host, video: [], audio: [], start: s.t, end: s.t }));
      g[meta.kind].push(s);
      if (s.t < g.start) g.start = s.t;
      if (s.t > g.end) g.end = s.t;
    }

    // 前の PeerConnection が終わってから始まったものは、その視聴の再接続とみなす
    const units = [];
    for (const pc of [...pcs.values()].sort((a, b) => a.start - b.start)) {
      const u = units.find((x) => x.end < pc.start);
      if (u) {
        u.pcs.push(pc);
        u.end = pc.end;
      } else {
        units.push({ pcs: [pc], end: pc.end });
      }
    }

    const all = units.map((u) => analyze(u.pcs, cfg));
    // 受信が一度も始まらなかったもの（接続だけ張られた予備の PC など）は落とす。全滅なら一番長いものだけ残す
    const live = all.filter((p) => p.recvSec > 0);
    const viewings = live.length ? live.sort((a, b) => a.start - b.start) : all.sort((a, b) => b.n - a.n).slice(0, 1);
    return { hasOut, viewings };
  }

  function analyze(pcs, cfg) {
    // 種類ごとに、PeerConnection の中で一番サンプルの多いストリーム（mid）を評価対象にする
    const video = [];
    const audio = [];
    const extra = { video: 0, audio: 0 };
    for (const pc of pcs) {
      for (const kind of ['video', 'audio']) {
        const byMid = new Map();
        for (const s of pc[kind]) {
          const m = s.mid ?? '';
          if (!byMid.has(m)) byMid.set(m, []);
          byMid.get(m).push(s);
        }
        const groups = [...byMid.values()].sort((a, b) => b.length - a.length);
        if (!groups.length) continue;
        extra[kind] = Math.max(extra[kind], groups.length - 1);
        const out = kind === 'video' ? video : audio;
        for (const s of groups[0]) out.push({ ...s, pc: pc.pcId });
      }
    }
    video.sort((a, b) => a.t - b.t);
    audio.sort((a, b) => a.t - b.t);

    // 時間の重みは映像を基準にする（音声だけの受信なら音声）
    const base = video.length ? video : audio;
    const { step, holes } = weigh(base);
    if (base !== audio) weigh(audio);
    const n = base.length;

    let totalSec = 0, recvSec = 0, hiddenSec = 0;
    for (const s of base) {
      totalSec += s._dt;
      if (s.state === 'connected' && num(s.bps) && s.bps > 0) recvSec += s._dt;
      if (s.visible === false) hiddenSec += s._dt;
    }
    // 受信開始。ここより前は ICE やキーフレーム待ちで値が荒れるので連続値の集計から除く
    const startT = base.find((s) => s.state === 'connected' && num(s.bps) && s.bps > 0)?.t ?? Infinity;
    const th = cfg.thresholds;

    // 連続値の系列。null は「値なし」で、グラフではそこで線を切る
    const ser = (arr, f, visibleOnly) =>
      arr.map((s) => ({
        t: s.t,
        pc: s.pc,
        w: s._dt,
        v: s.t >= startT && num(s[f]) && !(visibleOnly && s.visible === false) ? s[f] : null,
      }));
    const series = {
      bps: ser(video, 'bps'),
      bufferMs: ser(video.length ? video : audio, 'jbMs'),
      lossPct: lossSeries(video, audio, startT, base),
      // 非表示のタブはブラウザが描画を間引くので、fps は当てにならない
      fps: ser(video, 'fps', true),
      concealPct: ser(audio, 'concealPct'),
      rttMs: ser(base, 'rttMs'),
    };

    const cont = {};
    for (const m of CONT) {
      const pts = series[m.key].filter((q) => q.v != null);
      cont[m.key] = contStats(
        pts.map((q) => q.v),
        pts.map((q) => q.w),
        th[m.key]
      );
    }

    // ---- 出来事
    const events = [];
    const medBps = median(series.bps.filter((q) => q.v != null).map((q) => q.v));

    // フリーズと途切れ（pause）。累積値なので PeerConnection が変わったら数え直す
    const fz = { total: 0, sec: 0 };
    const pause = { total: 0, sec: 0 };
    let prevF = null, prevP = null, prevPc = null;
    video.forEach((s, i) => {
      if (s.pc !== prevPc) {
        prevF = prevP = null;
        prevPc = s.pc;
      }
      if (num(s.freezes)) {
        const d = prevF == null ? 0 : s.freezes >= prevF ? s.freezes - prevF : s.freezes;
        prevF = s.freezes;
        if (d > 0 && s.visible !== false) {
          const sec = num(s.freezeMs) ? s.freezeMs / 1000 : null;
          fz.total += d;
          fz.sec += sec || 0;
          // 回数と時間はフリーズが明けたときに増えるので、始まりは時間ぶん遡る
          events.push({ t: s.t - (sec || 0) * 1000, end: s.t, kind: 'freeze', n: d, sec, cause: freezeCause(video, i, medBps) });
        }
      }
      if (num(s.pauses)) {
        const d = prevP == null ? 0 : s.pauses >= prevP ? s.pauses - prevP : s.pauses;
        prevP = s.pauses;
        if (d > 0) {
          const sec = num(s.pauseMs) ? s.pauseMs / 1000 : null;
          pause.total += d;
          pause.sec += sec || 0;
          events.push({ t: s.t - (sec || 0) * 1000, end: s.t, kind: 'pause', n: d, sec });
        }
      }
    });
    fz.level = levelOf(th.freeze, fz.total);

    // 再接続（PeerConnection のつなぎ目）
    for (let i = 1; i < pcs.length; i++) {
      events.push({ t: pcs[i].start, kind: 'reconnect', gap: (pcs[i].start - pcs[i - 1].end) / 1000, from: pcs[i - 1].pcId, to: pcs[i].pcId });
    }

    // 切断（connected から外れた区間）・経路の切り替え
    let down = null;
    let prevRoute = null, prevPairs = null;
    prevPc = null;
    for (const s of base) {
      if (s.pc !== prevPc) {
        if (down) down = null;
        prevRoute = prevPairs = null;
        prevPc = s.pc;
      }
      const bad = s.state === 'disconnected' || s.state === 'failed';
      if (bad && !down) {
        down = { t: s.t, end: s.t, kind: 'disconnect', state: s.state };
        events.push(down);
      } else if (bad && down) {
        down.end = s.t;
        if (s.state === 'failed') down.state = 'failed';
      } else if (!bad && down) {
        down.sec = (s.t - down.t) / 1000;
        down = null;
      }
      const routeChanged = s.route && prevRoute && s.route !== prevRoute;
      const pairChanged = num(s.pairChanges) && num(prevPairs) && s.pairChanges > prevPairs;
      if (routeChanged || pairChanged) events.push({ t: s.t, kind: 'route', from: prevRoute, to: s.route });
      if (s.route) prevRoute = s.route;
      if (num(s.pairChanges)) prevPairs = s.pairChanges;
    }

    // 解像度の変化
    let up = 0, dn = 0, prevRes = null;
    prevPc = null;
    const resolutions = new Map();
    for (const s of video) {
      if (s.pc !== prevPc) {
        prevRes = null;
        prevPc = s.pc;
      }
      if (!num(s.w) || !num(s.h) || !s.w || !s.h) continue;
      const res = `${s.w}×${s.h}`;
      if (s.t >= startT) resolutions.set(res, (resolutions.get(res) || 0) + s._dt);
      if (prevRes && prevRes.res !== res) {
        const isUp = s.w * s.h > prevRes.w * prevRes.h;
        isUp ? up++ : dn++;
        events.push({ t: s.t, kind: isUp ? 'resUp' : 'resDown', from: prevRes.res, to: res });
      }
      prevRes = { res, w: s.w, h: s.h };
    }
    events.sort((a, b) => a.t - b.t);

    // ---- 受信ストリームの概要
    const routes = new Map();
    for (const s of base) if (s.route && s.t >= startT) routes.set(s.route, (routes.get(s.route) || 0) + s._dt);
    const relaySec = [...routes].filter(([r]) => /relay/.test(r)).reduce((a, [, v]) => a + v, 0);
    const routeSec = [...routes.values()].reduce((a, v) => a + v, 0);

    const pick = (arr, f) => arr.filter((s) => s.t >= startT).map((s) => s[f]).filter(num);
    const sum = (arr, f) => arr.reduce((a, s) => a + (num(s[f]) ? s[f] : 0), 0);

    const levels = [...CONT.filter((m) => cont[m.key].n).map((m) => cont[m.key].level), fz.level];

    return {
      pcs: pcs.map((p) => p.pcId),
      video,
      audio,
      series,
      extra,
      n,
      step,
      holes,
      start: Math.min(base[0]?.t ?? Infinity, audio[0]?.t ?? Infinity),
      end: Math.max(base[n - 1]?.t ?? 0, audio[audio.length - 1]?.t ?? 0),
      totalSec,
      recvSec,
      hiddenSec,
      cont,
      freeze: fz,
      pause,
      events,
      up,
      down: dn,
      reconnects: pcs.length - 1,
      disconnects: events.filter((e) => e.kind === 'disconnect').length,
      loss: {
        video: lossRatio(video, startT),
        audio: lossRatio(audio, startT),
        all: lossRatio([...video, ...audio], startT),
      },
      avgBps: weightedMean(video, 'bps', startT),
      avgAudioBps: weightedMean(audio, 'bps', startT),
      concealMean: cont.concealPct.n ? cont.concealPct.mean : null,
      jitter: { video: median(pick(video, 'jitterMs')), audio: median(pick(audio, 'jitterMs')) },
      decodeMs: median(pick(video, 'decodeMs')),
      codecs: {
        video: [...new Set(video.map((s) => s.codec).filter(Boolean))],
        audio: [...new Set(audio.map((s) => s.codec).filter(Boolean))],
      },
      resolutions: [...resolutions].map(([res, sec]) => ({ res, sec })).sort((a, b) => b.sec - a.sec),
      routes: [...routes].map(([route, sec]) => ({ route, sec })).sort((a, b) => b.sec - a.sec),
      relayRatio: routeSec ? relaySec / routeSec : null,
      recovery: {
        nack: sum(video, 'nack'),
        rtx: sum(video, 'rtx'),
        pli: sum(video, 'pli'),
        fir: sum(video, 'fir'),
        dropped: sum(video, 'dropped'),
        discarded: sum(video, 'discarded') + sum(audio, 'discarded'),
      },
      verdict: Math.max(LV.ok, ...levels),
    };
  }

  /**
   * サンプルごとの重み（秒）を s._dt に入れる。中央値の3倍を超える間は「記録の欠け」とみなし、
   * 重みに数えない。PeerConnection の切り替わりは欠けではなく再接続として別に数える。
   */
  function weigh(arr) {
    const gaps = [];
    for (let i = 1; i < arr.length; i++) if (arr[i].pc === arr[i - 1].pc) gaps.push(arr[i].t - arr[i - 1].t);
    const step = median(gaps) || 1000;
    let holes = 0;
    arr.forEach((s, i) => {
      const prev = arr[i - 1];
      if (!prev || prev.pc !== s.pc) {
        s._dt = step / 1000;
        return;
      }
      const g = s.t - prev.t;
      if (g > step * 3) holes++;
      s._dt = Math.min(g, step * 3) / 1000;
    });
    return { step, holes };
  }

  /**
   * サンプルごとのロス率。映像と音声のパケット数を同じ時刻で足し合わせる。
   * 0.6.0 より前の記録にはパケット数が無いので、映像（無ければ音声）の lossPct で代用する。
   */
  function lossSeries(video, audio, startT, base) {
    const at = new Map();
    for (const s of [...video, ...audio]) {
      if (!num(s.pktRecv) || !num(s.pktLost)) continue;
      let e = at.get(s.t);
      if (!e) at.set(s.t, (e = { t: s.t, pc: s.pc, w: s._dt, lost: 0, recv: 0 }));
      e.lost += s.pktLost;
      e.recv += s.pktRecv;
    }
    if (!at.size) {
      return base.map((s) => ({ t: s.t, pc: s.pc, w: s._dt, v: s.t >= startT && num(s.lossPct) ? s.lossPct : null }));
    }
    return [...at.values()]
      .sort((a, b) => a.t - b.t)
      .map((e) => ({ t: e.t, pc: e.pc, w: e.w, v: e.t >= startT && e.lost + e.recv > 0 ? (e.lost / (e.lost + e.recv)) * 100 : null }));
  }

  /** 期間全体の損失率（0〜1）。パケット数が記録されていなければ null */
  function lossRatio(arr, startT) {
    let lost = 0, recv = 0, any = false;
    for (const s of arr) {
      if (s.t < startT || !num(s.pktRecv) || !num(s.pktLost)) continue;
      lost += s.pktLost;
      recv += s.pktRecv;
      any = true;
    }
    return any && lost + recv > 0 ? lost / (lost + recv) : null;
  }

  /** 受信中の時間で重み付けした平均 */
  function weightedMean(arr, f, startT) {
    let sum = 0, w = 0;
    for (const s of arr) {
      if (s.t < startT || s.state !== 'connected' || !num(s[f])) continue;
      sum += s[f] * s._dt;
      w += s._dt;
    }
    return w ? sum / w : null;
  }

  /** 連続値の統計と判定 */
  function contStats(vals, w, t) {
    if (!vals.length) return { n: 0, level: LV.ok };
    const sorted = [...vals].sort((a, b) => a - b);
    const below = t?.dir === 'below';
    const rep = quantile(sorted, below ? 0.05 : 0.95);
    let wAll = 0, wWarn = 0, wCrit = 0, sum = 0;
    vals.forEach((v, i) => {
      wAll += w[i];
      sum += v * w[i];
      const lv = levelOf(t, v);
      if (lv >= LV.warn) wWarn += w[i];
      if (lv >= LV.crit) wCrit += w[i];
    });
    return {
      n: vals.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: wAll ? sum / wAll : null,
      median: quantile(sorted, 0.5),
      rep,
      below,
      warnRatio: wAll ? wWarn / wAll : 0,
      critRatio: wAll ? wCrit / wAll : 0,
      level: levelOf(t, rep),
    };
  }

  /** 小窓（overlay.js の level）と同じ比較。空欄の段階は判定しない */
  function levelOf(t, v) {
    if (!t || v == null) return LV.ok;
    const below = t.dir === 'below';
    const hit = (lim) => lim != null && (below ? v <= lim : v >= lim);
    if (hit(t.crit)) return LV.crit;
    if (hit(t.warn)) return LV.warn;
    return LV.ok;
  }

  /**
   * フリーズの直前（フリーズ時間 + 5秒）を見て、原因の手がかりを1つ返す。
   * 断定はしない。レポートの文面でも「推定」と書く。README の切り分け表と同じ考え方。
   */
  function freezeCause(video, i, medBps) {
    const s = video[i];
    const from = s.t - (num(s.freezeMs) ? s.freezeMs : 0) - 5000;
    let net = false, starve = false, key = false, dev = false;
    for (let j = i; j >= 0 && video[j].t >= from && video[j].pc === s.pc; j--) {
      const q = video[j];
      if (q.pktLost > 0 || q.nack > 0 || q.rtx > 0) net = true;
      if (medBps && num(q.bps) && q.bps < medBps * 0.1) starve = true;
      if (q.pli > 0 || q.fir > 0) key = true;
      if (q.dropped > 0) dev = true;
      // 1フレームのデコードにフレーム間隔の8割以上かかっていれば、端末が追いついていない
      if (num(q.decodeMs) && num(q.fps) && q.fps > 0 && q.decodeMs > (1000 / q.fps) * 0.8) dev = true;
    }
    if (net) return 'ネットワーク';
    if (starve) return '供給停止';
    if (key) return 'キーフレーム待ち';
    if (dev) return '端末側';
    return null;
  }

  // ------------------------------------------------------------ 描画

  function render(sessions, cfg) {
    const r = cfg.report;
    const sec = r.sections;
    const items = sessions.flatMap(({ session, viewings }) => viewings.map((p) => ({ session, p })));
    const hasOut = sessions.some((x) => x.hasOut);

    let html = '';
    const header = (start, end, worst, multi) => `
      <header class="cover">
        <h1>${esc(r.title)}</h1>
        <dl class="meta">
          <div><dt>計測期間</dt><dd>${esc(stamp(start))} 〜 ${esc(stamp(end))}</dd></div>
          <div><dt>対象</dt><dd>${esc([...new Set(sessions.map((x) => x.session.host))].join(', '))}</dd></div>
          <div><dt>評価範囲</dt><dd>受信した映像・音声${hasOut ? '（送信したストリームは対象外）' : ''}</dd></div>
          ${r.author ? `<div><dt>作成</dt><dd>${esc(r.author)}</dd></div>` : ''}
          <div><dt>出力日時</dt><dd>${esc(stamp(Date.now()))}</dd></div>
        </dl>
        ${worst != null && sec.summary ? verdictBadge(worst, multi ? '全体の判定' : '総合判定') : ''}
      </header>`;

    const usable = items.filter((x) => x.p.n);
    if (!usable.length) {
      const start = Math.min(...sessions.map((x) => x.session.start));
      const end = Math.max(...sessions.map((x) => x.session.end));
      return (
        header(start, end, null, false) +
        `<section><p class="lead">受信した映像・音声の記録がありません。${hasOut ? '送信だけのセッションは、このレポートでは評価しません。' : ''}</p></section>` +
        footer()
      );
    }

    const start = Math.min(...usable.map((x) => x.p.start));
    const end = Math.max(...usable.map((x) => x.p.end));
    const worst = Math.max(...usable.map((x) => x.p.verdict));
    const multi = usable.length > 1;
    html += header(start, end, worst, multi);
    if (multi) html += compareTable(usable);

    usable.forEach(({ session, p }, i) => {
      const title = multi
        ? `${i + 1}. ${session.host}　${stamp(p.start)} 〜 ${stamp(p.end).slice(11)}（${p.pcs.join(' → ')}）`
        : null;
      html += `<article class="${multi ? 'player paged' : 'player'}">`;
      if (title) html += `<h2 class="ptitle">${esc(title)}</h2>`;
      if (sec.summary) html += summary(p, cfg, !multi);
      if (sec.kpi) html += kpi(p);
      if (sec.judgement) html += judgement(p, cfg);
      if (sec.charts) html += charts(p, cfg);
      if (sec.events) html += eventList(p);
      if (sec.stream) html += stream(p);
      if (sec.conditions) html += conditions(p, session, sessions.find((x) => x.session === session).hasOut);
      html += '</article>';
    });

    if (sec.criteria) html += criteria(cfg);
    return html + footer();
  }

  function footer() {
    return `<footer class="foot">WebRTC Analyzer ${esc(version())} で作成。数値はブラウザの getStats() による受信側の実測で、配信サーバーや送信側の記録とは一致しない場合があります。</footer>`;
  }

  function verdictBadge(lv, label) {
    const v = VERDICT[lv];
    return `<div class="verdict ${v.key}"><span class="vl">${esc(label)}</span><span class="vv">${v.label}</span></div>`;
  }

  function compareTable(items) {
    return `
      <section>
        <h2>セッション一覧</h2>
        <table class="grid">
          <thead><tr><th>#</th><th>開始</th><th>対象</th><th>受信時間</th><th>フリーズ</th><th>パケットロス率</th><th>平均ビットレート</th><th>判定</th></tr></thead>
          <tbody>
          ${items
            .map(
              ({ session, p }, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${esc(stamp(p.start))}</td>
              <td>${esc(session.host)}</td>
              <td>${esc(dur(p.recvSec))}</td>
              <td>${p.freeze.total} 回 / ${fix(p.freeze.sec, 1)} 秒</td>
              <td>${esc(pct(p.loss.all, 2))}</td>
              <td>${esc(bps(p.avgBps ?? p.avgAudioBps))}</td>
              <td><span class="tag ${VERDICT[p.verdict].key}">${VERDICT[p.verdict].label}</span></td>
            </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  /** 総合判定と所見。数値の羅列ではなく「何が起きたか → 推定される原因」の順で書く */
  function summary(p, cfg, withBadge) {
    const findings = findingsOf(p, cfg);
    const nCrit = findings.filter((f) => f.lv === LV.crit).length;
    const nWarn = findings.filter((f) => f.lv === LV.warn).length;
    let lead;
    if (p.verdict === LV.crit) {
      lead = `計測期間（受信 ${dur(p.recvSec)}）のうち、${nCrit} 項目で重大値を超えており、視聴品質に影響が出ていました。`;
    } else if (p.verdict === LV.warn) {
      lead = `受信 ${dur(p.recvSec)} を通じて概ね継続しましたが、${nWarn} 項目で警告値を超えました。`;
    } else {
      lead = `受信 ${dur(p.recvSec)} を通じて、設定したしきい値を超える項目はなく、安定した受信品質でした。`;
    }
    const notes = [];
    if (p.reconnects) notes.push(`接続が ${p.reconnects} 回張り直されました（再接続）。途切れていた時間はイベント一覧にあります。`);
    if (p.disconnects) notes.push(`接続が切れかけた（disconnected / failed）区間が ${p.disconnects} 回ありました。`);
    if (p.pause.total) notes.push(`5秒以上映像が届かない途切れが ${p.pause.total} 回（合計 ${fix(p.pause.sec, 1)} 秒）ありました。`);
    if (p.down > 0) notes.push(`受信解像度の引き下げが ${p.down} 回ありました（引き上げ ${p.up} 回）。`);
    if (p.hiddenSec > p.totalSec * 0.1) notes.push(`タブが非表示だった時間が ${pct(p.hiddenSec / p.totalSec)} あり、その間のフレームレートとフリーズは集計から除いています。`);

    return `
      <section class="summary">
        <h2>総合判定と所見</h2>
        ${withBadge ? '' : verdictBadge(p.verdict, '判定')}
        <p class="lead">${esc(lead)}</p>
        ${
          findings.length
            ? `<ul class="findings">${findings
                .map((f) => `<li class="${VERDICT[f.lv].key}"><span class="tag ${VERDICT[f.lv].key}">${VERDICT[f.lv].label}</span>${esc(f.text)}</li>`)
                .join('')}</ul>`
            : ''
        }
        ${notes.length ? `<p class="note">${esc(notes.join(''))}</p>` : ''}
      </section>`;
  }

  function findingsOf(p, cfg) {
    const th = cfg.thresholds;
    const out = [];
    const c = p.cont;
    const lim = (key, lv) => th[key][lvKey(lv)];

    const fz = p.freeze;
    if (fz.level) {
      const causes = p.events.filter((e) => e.kind === 'freeze').map((e) => e.cause);
      const cnt = (x) => causes.filter((y) => y === x).length;
      let text = `映像のフリーズが ${fz.total} 回（合計 ${fix(fz.sec, 1)} 秒、受信時間の ${pct(fz.sec / Math.max(p.recvSec, 1))}）発生しました。`;
      if (cnt('ネットワーク')) text += `うち ${cnt('ネットワーク')} 回は直前にパケットロスや再送があり、回線または配信経路での損失・遅延が原因と推定されます。`;
      if (cnt('供給停止')) text += `うち ${cnt('供給停止')} 回はロスが無いまま受信ビットレートが落ちており、送信側（エンコーダ・配信サーバー）からの供給が止まっていたと推定されます。`;
      if (cnt('キーフレーム待ち')) text += `うち ${cnt('キーフレーム待ち')} 回は直前にキーフレーム要求（PLI / FIR）が出ており、キーフレームの到着待ちで止まっていたと推定されます。`;
      if (cnt('端末側')) text += `うち ${cnt('端末側')} 回は直前に表示を捨てたフレームやデコードの遅れがあり、端末側（デコード・描画）の処理不足が原因と推定されます。`;
      out.push({ lv: fz.level, text });
    }
    if (c.lossPct.level) {
      out.push({
        lv: c.lossPct.level,
        text:
          `パケットロス率の上位5%値が ${fix(c.lossPct.rep, 2)}% で、${lvName(c.lossPct.level)}（${lim('lossPct', c.lossPct.level)}%）以上でした。` +
          (p.loss.all != null ? `期間全体の損失率は ${pct(p.loss.all, 2)} です。` : '') +
          '回線または配信経路で損失が起きています。',
      });
    }
    if (c.bufferMs.level) {
      out.push({
        lv: c.bufferMs.level,
        text: `ジッターバッファ遅延の上位5%値が ${fix(c.bufferMs.rep, 0)} ms で、${lvName(c.bufferMs.level)}（${lim('bufferMs', c.bufferMs.level)} ms）以上でした（警告値以上だった時間 ${pct(c.bufferMs.warnRatio)}）。到着の揺らぎを吸収するために受信側が遅延を積み増しており、その分だけ映像が遅れて表示されます。`,
      });
    }
    if (c.fps.level) {
      const slowDecode = p.decodeMs != null && c.fps.median > 0 && p.decodeMs > (1000 / c.fps.median) * 0.5;
      out.push({
        lv: c.fps.level,
        text:
          `受信映像のフレームレートの下位5%値が ${fix(c.fps.rep, 1)} fps で、${lvName(c.fps.level)}（${lim('fps', c.fps.level)} fps）以下でした（タブ非表示中を除く）。` +
          (slowDecode
            ? `1フレームのデコードに中央値で ${fix(p.decodeMs, 1)} ms かかっており、端末の処理能力不足が疑われます。`
            : '送信側でフレームを間引いているか、受信が途切れがちだったと考えられます。配信側の設定 fps も確認してください。'),
      });
    }
    if (c.concealPct.level) {
      out.push({
        lv: c.concealPct.level,
        text: `音声の補間率の上位5%値が ${fix(c.concealPct.rep, 2)}% で、${lvName(c.concealPct.level)}（${lim('concealPct', c.concealPct.level)}%）以上でした。届かなかった音声を推測で埋めた区間があり、途切れやノイズとして聞こえた可能性があります。`,
      });
    }
    if (c.rttMs.level) {
      out.push({
        lv: c.rttMs.level,
        text:
          `往復遅延（RTT）の上位5%値が ${fix(c.rttMs.rep, 0)} ms で、${lvName(c.rttMs.level)}（${lim('rttMs', c.rttMs.level)} ms）以上でした。` +
          (p.relayRatio ? `経路が relay（TURN 経由）だった時間が ${pct(p.relayRatio)} あります。` : '') +
          '経路が長いか、途中で混雑しています。',
      });
    }
    return out.sort((a, b) => b.lv - a.lv);
  }

  function kpi(p) {
    const c = p.cont;
    const fz = p.freeze;
    const cards = [
      ['受信時間', dur(p.recvSec), `記録 ${dur(p.totalSec)}`, null],
      ['フリーズ', `${fz.total} 回`, `${fix(fz.sec, 1)} 秒 / 受信時間の ${pct(fz.sec / Math.max(p.recvSec, 1))}`, fz.level],
      ['パケットロス率', pct(p.loss.all, 2), c.lossPct.n ? `上位5% ${fix(c.lossPct.rep, 2)}%` : '', c.lossPct.level],
      p.avgBps != null
        ? ['平均ビットレート（映像）', bps(p.avgBps), p.avgAudioBps != null ? `音声 ${bps(p.avgAudioBps)}` : '', null]
        : ['平均ビットレート（音声）', bps(p.avgAudioBps), '映像の受信なし', null],
      ['フレームレート', c.fps.n ? `${fix(c.fps.median, 1)} fps` : '—', c.fps.n ? `下位5% ${fix(c.fps.rep, 1)} fps` : '', c.fps.level],
      ['ジッターバッファ', c.bufferMs.n ? `${fix(c.bufferMs.median, 0)} ms` : '—', c.bufferMs.n ? `上位5% ${fix(c.bufferMs.rep, 0)} ms` : '', c.bufferMs.level],
      ['音声の補間率', c.concealPct.n ? `${fix(c.concealPct.mean, 2)}%` : '—', c.concealPct.n ? `上位5% ${fix(c.concealPct.rep, 2)}%` : '', c.concealPct.level],
      ['RTT', c.rttMs.n ? `${fix(c.rttMs.median, 0)} ms` : '—', c.rttMs.n ? `上位5% ${fix(c.rttMs.rep, 0)} ms` : '', c.rttMs.level],
    ];
    return `
      <section>
        <h2>主要指標</h2>
        <div class="kpis">
          ${cards
            .map(
              ([label, value, sub, lv]) => `
            <div class="kpi ${lv ? VERDICT[lv].key : ''}">
              <div class="kl">${esc(label)}</div>
              <div class="kv">${esc(value)}</div>
              <div class="ks">${esc(sub || '')}</div>
            </div>`
            )
            .join('')}
        </div>
      </section>`;
  }

  function judgement(p, cfg) {
    const th = cfg.thresholds;
    const rows = [];
    for (const m of CONT) {
      const c = p.cont[m.key];
      const t = th[m.key];
      if (!c.n) {
        rows.push([m.label, '—', limits(t, m.unit), '—', 'データなし', null]);
        continue;
      }
      rows.push([
        m.label,
        `${fix(c.rep, m.digits)} ${m.unit}（${c.below ? '下位' : '上位'}5%）`,
        limits(t, m.unit),
        `警告 ${pct(c.warnRatio)} / 重大 ${pct(c.critRatio)}`,
        `最小 ${fix(c.min, m.digits)} / 中央 ${fix(c.median, m.digits)} / 最大 ${fix(c.max, m.digits)}`,
        c.level,
      ]);
    }
    rows.push(['フリーズ', `${p.freeze.total} 回（合計）`, limits(th.freeze, '回'), '—', `合計 ${fix(p.freeze.sec, 1)} 秒`, p.freeze.level]);
    return `
      <section>
        <h2>しきい値判定</h2>
        <table class="grid">
          <thead><tr><th>指標</th><th>判定に使った値</th><th>しきい値</th><th>超過時間の割合</th><th>分布</th><th>判定</th></tr></thead>
          <tbody>
          ${rows
            .map(
              ([a, b, c, d, e, lv]) => `
            <tr>
              <td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td><td>${esc(d)}</td><td class="dim">${esc(e)}</td>
              <td>${lv == null ? '—' : `<span class="tag ${VERDICT[lv].key}">${VERDICT[lv].label}</span>`}</td>
            </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  function limits(t, unit) {
    if (!t) return '—';
    const dir = t.dir === 'below' ? '以下' : '以上';
    const f = (v) => (v == null ? '判定なし' : `${v} ${unit}${dir}`);
    return `警告 ${f(t.warn)} / 重大 ${f(t.crit)}`;
  }

  // ------------------------------------------------------------ グラフ

  function charts(p, cfg) {
    const c = cfg.report.charts;
    const th = cfg.thresholds;
    const s = p.series;
    const list = [];
    if (c.bitrate && p.video.length) list.push({ title: '受信ビットレート（映像、Mbps）', pts: s.bps, scale: 1e-6 });
    if (c.fps && p.video.length) list.push({ title: 'フレームレート（fps、タブ非表示中を除く）', pts: s.fps, th: th.fps });
    if (c.buffer) list.push({ title: 'ジッターバッファ遅延（ms）', pts: s.bufferMs, th: th.bufferMs });
    if (c.loss) list.push({ title: 'パケットロス率（%、20% で頭打ち）', pts: s.lossPct, th: th.lossPct, cap: 20 });
    if (c.rtt) list.push({ title: '往復遅延 RTT（ms）', pts: s.rttMs, th: th.rttMs });
    if (c.conceal && p.audio.length) list.push({ title: '音声の補間率（%、50% で頭打ち）', pts: s.concealPct, th: th.concealPct, cap: 50 });
    if (!list.length) return '';

    return `
      <section class="charts">
        <h2>時系列</h2>
        <p class="legend">
          <span class="lg crit"></span>重大値 <span class="lg warn"></span>警告値
          <span class="lg band"></span>フリーズ・途切れ <span class="lg err"></span>再接続・切断
        </p>
        ${list.map((ch) => chart(p, ch)).join('')}
      </section>`;
  }

  /** 1枚の折れ線。全グラフで時間軸を揃え、フリーズと再接続を重ねて描く */
  function chart(p, ch) {
    const W = 700, H = 130, L = 44, R = 8, T = 8, B = 20;
    const t0 = p.start, t1 = Math.max(p.end, p.start + 1);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);

    // 値なし・記録の欠け・PeerConnection の切り替わりで線を切る
    const pts = [];
    ch.pts.forEach((q, i) => {
      const prev = ch.pts[i - 1];
      if (prev && (prev.pc !== q.pc || q.t - prev.t > p.step * 3)) pts.push(null);
      if (q.v == null) return pts.push(null);
      let v = q.v * (ch.scale || 1);
      if (ch.cap) v = Math.min(v, ch.cap);
      pts.push([q.t, v]);
    });
    const line = thin(pts, W - L - R);
    const vals = line.filter(Boolean).map((q) => q[1]);
    if (!vals.length) return `<figure class="chart"><figcaption>${esc(ch.title)}</figcaption><p class="dim">データなし</p></figure>`;

    let ymax = Math.max(...vals);
    if (ch.th) for (const k of ['warn', 'crit']) if (ch.th[k] != null && (!ch.cap || ch.th[k] <= ch.cap)) ymax = Math.max(ymax, ch.th[k]);
    ymax = nice(ymax || 1);
    const y = (v) => T + (1 - v / ymax) * (H - T - B);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="plot" role="img" aria-label="${esc(ch.title)}">`;
    // 目盛り
    for (const v of [0, ymax / 2, ymax]) {
      svg += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="ax" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmtAxis(v)}</text>`;
    }
    for (let k = 0; k <= 4; k++) {
      const t = t0 + ((t1 - t0) * k) / 4;
      svg += `<text class="ax" x="${x(t)}" y="${H - 5}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${esc(stamp(t).slice(11, 19))}</text>`;
    }
    // フリーズ・途切れの区間と、再接続・切断
    for (const e of p.events) {
      if (e.kind === 'freeze' || e.kind === 'pause') {
        const xa = x(e.t), xb = Math.max(x(e.end || e.t), xa + 1.5);
        svg += `<rect class="band" x="${xa}" y="${T}" width="${xb - xa}" height="${H - T - B}"/>`;
      } else if (e.kind === 'reconnect' || e.kind === 'disconnect') {
        svg += `<line class="err" x1="${x(e.t)}" x2="${x(e.t)}" y1="${T}" y2="${H - B}"/>`;
      }
    }
    // しきい値
    if (ch.th) {
      for (const k of ['warn', 'crit']) {
        const v = ch.th[k];
        if (v == null || v > ymax) continue;
        svg += `<line class="th ${k}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      }
    }
    // 系列
    let d = '', pen = false;
    for (const q of line) {
      if (!q) {
        pen = false;
        continue;
      }
      const px = x(q[0]).toFixed(1), py = y(q[1]).toFixed(1);
      d += `${pen ? 'L' : 'M'}${px},${py}`;
      pen = true;
    }
    svg += `<path class="ln s1" d="${d}"/>`;
    svg += `<line class="axl" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/></svg>`;

    return `
      <figure class="chart">
        <figcaption>${esc(ch.title)}</figcaption>
        ${svg}
      </figure>`;
  }

  /** 点が描画幅より多いときは、区間ごとの最小と最大だけを残す（山と谷を消さない） */
  function thin(pts, width) {
    const target = Math.max(100, Math.floor(width));
    if (pts.length <= target * 2) return pts;
    const per = pts.length / target;
    const out = [];
    for (let b = 0; b < target; b++) {
      const seg = pts.slice(Math.floor(b * per), Math.floor((b + 1) * per));
      const ok = seg.filter(Boolean);
      // 区間の中に切れ目があれば、間引いた後も線を切る
      if (!ok.length || ok.length < seg.length) out.push(null);
      if (!ok.length) continue;
      let lo = ok[0], hi = ok[0];
      for (const q of ok) {
        if (q[1] < lo[1]) lo = q;
        if (q[1] > hi[1]) hi = q;
      }
      out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
    }
    return out;
  }

  // ------------------------------------------------------------ 一覧・構成・条件

  const EVENT_LIMIT = 200;

  function eventList(p) {
    const list = p.events;
    if (!list.length) {
      return `<section><h2>イベント一覧</h2><p class="dim">フリーズ・途切れ・再接続・切断・解像度の変化・経路の切り替えはありませんでした。</p></section>`;
    }
    const label = {
      freeze: 'フリーズ',
      pause: '途切れ',
      reconnect: '再接続',
      disconnect: '切断',
      resUp: '解像度↑',
      resDown: '解像度↓',
      route: '経路変更',
    };
    const cls = { freeze: 'warn', pause: 'crit', reconnect: 'crit', disconnect: 'crit', resUp: '', resDown: 'warn', route: '' };
    const detail = (e) => {
      if (e.kind === 'freeze') return `${e.sec != null ? `${fix(e.sec, 2)} 秒` : ''}${e.n > 1 ? `（${e.n} 回）` : ''}${e.cause ? `　推定原因: ${e.cause}` : ''}`;
      if (e.kind === 'pause') return e.sec != null ? `${fix(e.sec, 1)} 秒` : '';
      if (e.kind === 'reconnect') return `途切れ ${fix(e.gap, 1)} 秒（${e.from} → ${e.to}）`;
      if (e.kind === 'disconnect') return `${e.state}${e.sec != null ? `　${fix(e.sec, 1)} 秒で復帰` : '　復帰せず'}`;
      return `${e.from || '—'} → ${e.to || '—'}`;
    };
    return `
      <section>
        <h2>イベント一覧</h2>
        <table class="grid events">
          <thead><tr><th>時刻</th><th>種類</th><th>内容</th></tr></thead>
          <tbody>
          ${list
            .slice(0, EVENT_LIMIT)
            .map((e) => `<tr><td>${esc(stamp(e.t).slice(11, 19))}</td><td><span class="tag ${cls[e.kind]}">${label[e.kind]}</span></td><td>${esc(detail(e))}</td></tr>`)
            .join('')}
          </tbody>
        </table>
        ${list.length > EVENT_LIMIT ? `<p class="dim">ほか ${list.length - EVENT_LIMIT} 件は省略しました。全件は CSV で確認できます。</p>` : ''}
      </section>`;
  }

  function stream(p) {
    const total = p.resolutions.reduce((a, v) => a + v.sec, 0) || 1;
    const rc = p.recovery;
    const routeText = p.routes.length
      ? p.routes.map((r) => `${r.route} ${pct(r.sec / (p.routes.reduce((a, x) => a + x.sec, 0) || 1))}`).join(' / ')
      : '—';
    return `
      <section>
        <h2>受信ストリーム</h2>
        <dl class="kv2">
          <div><dt>映像コーデック</dt><dd class="mono">${esc(p.codecs.video.join(', ') || '—')}</dd></div>
          <div><dt>音声コーデック</dt><dd class="mono">${esc(p.codecs.audio.join(', ') || '—')}</dd></div>
          <div><dt>平均ビットレート</dt><dd>映像 ${esc(bps(p.avgBps))} / 音声 ${esc(bps(p.avgAudioBps))}</dd></div>
          <div><dt>接続</dt><dd>${esc(p.pcs.join(' → '))}${p.reconnects ? `（再接続 ${p.reconnects} 回）` : ''}</dd></div>
          <div><dt>経路</dt><dd>${esc(routeText)}</dd></div>
          <div><dt>ジッター</dt><dd>映像 ${fix(p.jitter.video, 1)} ms / 音声 ${fix(p.jitter.audio, 1)} ms（中央値）</dd></div>
          <div><dt>デコード時間</dt><dd>${p.decodeMs != null ? `${fix(p.decodeMs, 2)} ms / フレーム（中央値）` : '—'}</dd></div>
          <div><dt>期間全体の損失率</dt><dd>映像 ${esc(pct(p.loss.video, 2))} / 音声 ${esc(pct(p.loss.audio, 2))}</dd></div>
          <div><dt>再送・回復（映像）</dt><dd>NACK ${rc.nack} / 再送で回復 ${rc.rtx} / PLI ${rc.pli} / FIR ${rc.fir}</dd></div>
          <div><dt>捨てた量</dt><dd>表示しなかったフレーム ${rc.dropped} / 破棄パケット ${rc.discarded}</dd></div>
        </dl>
        ${
          p.resolutions.length
            ? `<table class="grid">
          <thead><tr><th>受信解像度</th><th>受信時間の割合</th></tr></thead>
          <tbody>
          ${p.resolutions
            .map(
              (v) => `<tr><td>${esc(v.res)}</td>
              <td><span class="bar"><span style="width:${(v.sec / total) * 100}%"></span></span> ${pct(v.sec / total)}</td></tr>`
            )
            .join('')}
          </tbody>
        </table>`
            : ''
        }
      </section>`;
  }

  function conditions(p, session, hasOut) {
    const others = [];
    if (p.extra.video) others.push(`映像 ${p.extra.video} 本`);
    if (p.extra.audio) others.push(`音声 ${p.extra.audio} 本`);
    return `
      <section>
        <h2>計測条件</h2>
        <dl class="kv2">
          <div><dt>対象ホスト</dt><dd>${esc(session.host)}</dd></div>
          <div><dt>ブラウザ</dt><dd>${esc(session.browser || '記録なし')}</dd></div>
          <div><dt>記録期間</dt><dd>${esc(stamp(p.start))} 〜 ${esc(stamp(p.end))}（${dur(p.totalSec)}）</dd></div>
          <div><dt>サンプル</dt><dd>${p.n} 件 / 間隔 ${fix(p.step / 1000, 1)} 秒${p.holes ? `（記録の欠け ${p.holes} 箇所）` : ''}</dd></div>
          <div><dt>受信していない時間</dt><dd>${dur(Math.max(0, p.totalSec - p.recvSec))}（接続前・切断中を含む）</dd></div>
          <div><dt>タブ非表示</dt><dd>${dur(p.hiddenSec)}（フレームレートとフリーズの集計から除外）</dd></div>
          <div><dt>評価の対象</dt><dd>受信のみ${hasOut ? '（送信したストリームは対象外）' : ''}</dd></div>
          <div><dt>集計外の受信</dt><dd>${others.length ? `${others.join('・')}（同じ接続で並行して受信していたもの）` : 'なし'}</dd></div>
          <div><dt>計測した拡張</dt><dd>${session.version ? `v${esc(session.version)}` : '0.6.0 より前'}</dd></div>
        </dl>
      </section>`;
  }

  function criteria(cfg) {
    const th = cfg.thresholds;
    const rows = [
      ['フリーズ', th.freeze, '回', '期間中の合計（タブ非表示中を除く）'],
      ['パケットロス率', th.lossPct, '%', '上位5%値（サンプルごと、映像と音声の合算）'],
      ['ジッターバッファ遅延', th.bufferMs, 'ms', '上位5%値（映像。映像が無ければ音声）'],
      ['フレームレート', th.fps, 'fps', '下位5%値（映像、タブ非表示中を除く）'],
      ['音声の補間率', th.concealPct, '%', '上位5%値'],
      ['往復遅延（RTT）', th.rttMs, 'ms', '上位5%値'],
    ];
    return `
      <section class="criteria">
        <h2>判定基準</h2>
        <p class="dim">しきい値は WebRTC Analyzer の設定画面の値です。連続値は受信開始後のサンプルだけを使い、一時的な跳ねで判定が振れないよう
          分布の端（5%点）をしきい値と比べます。重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外を「良好」とします。
          ジッター（到着間隔のばらつき）は参考値として受信ストリームの章に載せ、判定には使いません。</p>
        <table class="grid">
          <thead><tr><th>指標</th><th>比べる値</th><th>警告</th><th>重大</th></tr></thead>
          <tbody>
          ${rows
            .map(([n, t, u, how]) => {
              const dir = t.dir === 'below' ? '以下' : '以上';
              const f = (v) => (v == null ? '判定なし' : `${v} ${u}${dir}`);
              return `<tr><td>${esc(n)}</td><td>${esc(how)}</td><td>${esc(f(t.warn))}</td><td>${esc(f(t.crit))}</td></tr>`;
            })
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  // ------------------------------------------------------------ 小物

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function median(a) {
    if (!a.length) return null;
    return quantile([...a].sort((x, y) => x - y), 0.5);
  }

  /** 線形補間の分位点。sorted は昇順 */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function nice(v) {
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * e) return m * e;
    return 10 * e;
  }

  function fmtAxis(v) {
    return v >= 100 ? Math.round(v) : +v.toFixed(v >= 10 ? 0 : v >= 1 ? 1 : 2);
  }

  function lvName(lv) {
    return lv === LV.crit ? '重大値' : '警告値';
  }
  function lvKey(lv) {
    return lv === LV.crit ? 'crit' : 'warn';
  }

  function fix(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
  }

  /** 割合（0〜1）を % で。digits を省くと 10% 未満だけ小数1桁 */
  function pct(r, digits) {
    if (r == null || !Number.isFinite(r)) return '—';
    const v = r * 100;
    if (digits != null) return `${v.toFixed(digits)}%`;
    return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
  }

  function bps(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mbps`;
    return `${Math.round(v / 1e3)} kbps`;
  }

  function dur(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}時間${m}分`;
    if (m) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function stamp(t) {
    return localStamp(t).slice(0, 19);
  }

  function version() {
    try {
      return 'v' + chrome.runtime.getManifest().version;
    } catch (_) {
      return '';
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();

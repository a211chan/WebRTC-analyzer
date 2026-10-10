/*
 * WebRTC Analyzer — 送信品質レポート（report.html?dir=out）
 *
 * 評価の対象は送信（outbound）だけ。受信したストリームの行は読み飛ばす。
 * 「送り出した映像・音声が、意図した品質のまま出ていたか」を見る。受け手の見え方は受信レポートの範囲。
 *
 * 集計の単位は「配信」。受信と同じく、時間の重ならない PeerConnection は再接続とみなしてつなぐ。
 * サイマルキャスト（rid ごとのレイヤー）は、最も解像度の高いレイヤーを評価の対象にし、
 * ビットレートは全レイヤーの合計を出す。レイヤーの内訳は送信ストリームの章に表で出す。
 *
 * 判定（しきい値は設定画面の値）
 *   - 品質制限: CPU・帯域による制限（qualityLimitationDurations）がかかっていた時間の割合を limitPct と比べる
 *   - 連続値（送信 fps・ロス率・RTT）: 上位5%値、低いほど悪い fps は下位5%値をしきい値と比べる
 *       ロス率と RTT は受け手からの受信報告（RTCP の remote-inbound-rtp）。SFU や配信サーバーを
 *       経由する場合、受け手はサーバーなので「送信者からサーバーまで」の区間の値になる。
 *   送信開始前（最初に connected でビットレートが出るまで）のサンプルは除く。
 */
(() => {
  'use strict';

  const R = WRA_REPORT;
  const { LV, num, median, fix, pct, bps, dur, stamp } = R;

  const CONT = [
    { key: 'fps', label: 'フレームレート（送信映像）', unit: 'fps', digits: 1 },
    { key: 'lossPct', label: 'パケットロス率（受け手の報告）', unit: '%', digits: 2 },
    { key: 'rttMs', label: '往復遅延（RTT）', unit: 'ms', digits: 0 },
  ];

  /** マイクの入力レベルがこれ未満なら無音とみなす（audioLevel は 0〜1） */
  const SILENT_LEVEL = 0.001;

  // ------------------------------------------------------------ 集計

  function analyzeSession(rows, cfg) {
    const { other, units } = R.groupByConnection(rows, 'out', (meta, s) => s.mid ?? '');
    const all = units.map((pcs) => analyze(pcs, cfg));
    const live = all.filter((p) => p.activeSec > 0);
    const items = live.length ? live.sort((a, b) => a.start - b.start) : all.sort((a, b) => b.n - a.n).slice(0, 1);
    return { other, items };
  }

  function analyze(pcs, cfg) {
    // 映像はサンプルの多い mid を選び、その中を rid（レイヤー）で分ける
    const layers = new Map();
    const audio = [];
    for (const pc of pcs) {
      const v = Object.values(pc.rows.video).sort((a, b) => b.length - a.length)[0] || [];
      for (const s of v) {
        if (!layers.has(s.rid)) layers.set(s.rid, []);
        layers.get(s.rid).push(s);
      }
      const a = Object.values(pc.rows.audio).sort((x, y) => y.length - x.length)[0] || [];
      audio.push(...a);
    }
    for (const arr of layers.values()) arr.sort((a, b) => a.t - b.t);
    audio.sort((a, b) => a.t - b.t);

    // 評価の対象は、解像度（無ければビットレート）の中央値が最も大きいレイヤー
    const size = (arr) => median(arr.filter((s) => num(s.w) && num(s.h)).map((s) => s.w * s.h)) ?? median(arr.map((s) => s.bps).filter(num)) ?? 0;
    const ranked = [...layers].sort((a, b) => size(b[1]) - size(a[1]));
    const topRid = ranked[0]?.[0] ?? '';
    const video = ranked[0]?.[1] ?? [];

    const base = video.length ? video : audio;
    const { step, holes } = R.weigh(base);
    for (const [, arr] of ranked) if (arr !== base) R.weigh(arr);
    if (base !== audio) R.weigh(audio);
    const n = base.length;

    let totalSec = 0, activeSec = 0, hiddenSec = 0;
    for (const s of base) {
      totalSec += s._dt;
      if (s.state === 'connected' && num(s.bps) && s.bps > 0) activeSec += s._dt;
      if (s.visible === false) hiddenSec += s._dt;
    }
    const startT = base.find((s) => s.state === 'connected' && num(s.bps) && s.bps > 0)?.t ?? Infinity;
    const th = cfg.thresholds;

    const ser = (arr, f) => arr.map((s) => ({ t: s.t, pc: s.pc, w: s._dt, v: s.t >= startT && num(s[f]) ? s[f] : null }));
    const series = {
      // 全レイヤーの合計
      bps: sumByTime(ranked.map(([, arr]) => arr), 'bps', startT),
      availBps: ser(base, 'availOutBps'),
      fps: ser(video, 'fps'),
      srcFps: ser(video, 'srcFps'),
      // 映像と音声の報告のうち悪い方
      lossPct: maxByTime([video, audio], 'lossPct', startT),
      rttMs: ser(base, 'rttMs'),
    };

    const cont = {};
    for (const m of CONT) cont[m.key] = R.seriesStats(series[m.key], th[m.key]);

    // ---- 品質制限
    const limit = { cpuSec: 0, bwSec: 0 };
    const hasDur = video.some((s) => num(s.limitCpuMs) || num(s.limitBwMs));
    for (const s of video) {
      if (s.t < startT) continue;
      if (hasDur) {
        limit.cpuSec += (s.limitCpuMs || 0) / 1000;
        limit.bwSec += (s.limitBwMs || 0) / 1000;
      } else if (s.limit === 'cpu') {
        // 0.6.0 より前の記録は制限時間を持たないので、その時点の理由で近似する
        limit.cpuSec += s._dt;
      } else if (s.limit === 'bandwidth') {
        limit.bwSec += s._dt;
      }
    }
    const videoSec = video.filter((s) => s.t >= startT && s.state === 'connected').reduce((a, s) => a + s._dt, 0);
    limit.baseSec = videoSec;
    limit.ratio = videoSec ? Math.min(1, (limit.cpuSec + limit.bwSec) / videoSec) : null;
    limit.level = limit.ratio == null ? LV.ok : R.levelOf(th.limitPct, limit.ratio * 100);

    // ---- 出来事
    const events = [...R.reconnectEvents(pcs), ...R.connectionEvents(base)];

    // 制限がかかっていた区間（理由が変わるたびに区切る）
    let cur = null, prevPc = null;
    for (const s of video) {
      if (s.pc !== prevPc) {
        cur = null;
        prevPc = s.pc;
      }
      const reason = s.limit === 'cpu' || s.limit === 'bandwidth' ? s.limit : null;
      if (reason && (!cur || cur.reason !== reason)) {
        cur = { t: s.t, end: s.t, kind: 'limit', reason, minRes: null };
        events.push(cur);
      } else if (!reason) {
        cur = null;
      }
      if (cur) {
        cur.end = s.t;
        cur.sec = (cur.end - cur.t) / 1000 + s._dt;
        if (num(s.w) && num(s.h) && (!cur.minRes || s.w * s.h < cur.minRes.w * cur.minRes.h)) cur.minRes = { w: s.w, h: s.h };
      }
    }

    // 送信停止（接続中なのに映像のビットレートがほぼ 0）。カメラを止めた・タブを切り替えたなど
    const medBps = median(video.filter((s) => s.t >= startT).map((s) => s.bps).filter(num));
    let stop = null;
    prevPc = null;
    for (const s of video) {
      if (s.pc !== prevPc) {
        stop = null;
        prevPc = s.pc;
      }
      const idle = s.t >= startT && s.state === 'connected' && medBps && num(s.bps) && s.bps < medBps * 0.02;
      if (idle && !stop) {
        stop = { t: s.t, end: s.t, kind: 'stop' };
        events.push(stop);
      } else if (idle) {
        stop.end = s.t;
      } else {
        stop = null;
      }
    }
    for (const e of events) if (e.kind === 'stop') e.sec = (e.end - e.t) / 1000 + step / 1000;

    // 解像度の変化（評価対象のレイヤー）
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
        events.push({ t: s.t, kind: isUp ? 'resUp' : 'resDown', from: prevRes.res, to: res, reason: s.limit || null });
      }
      prevRes = { res, w: s.w, h: s.h };
    }
    events.sort((a, b) => a.t - b.t);

    // ---- 送信ストリームの概要
    const after = (arr) => arr.filter((s) => s.t >= startT);
    const pick = (arr, f) => after(arr).map((s) => s[f]).filter(num);
    const sum = (arr, f) => arr.reduce((a, s) => a + (num(s[f]) ? s[f] : 0), 0);
    const srcW = median(pick(video, 'srcW'));
    const srcH = median(pick(video, 'srcH'));
    const levels = (aud) => after(aud).filter((s) => num(s.audioLevel));
    const lv = levels(audio);
    const silentSec = lv.filter((s) => s.audioLevel < SILENT_LEVEL).reduce((a, s) => a + s._dt, 0);
    const lvSec = lv.reduce((a, s) => a + s._dt, 0);

    const verdict = Math.max(LV.ok, limit.level, ...CONT.filter((m) => cont[m.key].n).map((m) => cont[m.key].level));

    return {
      pcs: pcs.map((p) => p.pcId),
      video,
      audio,
      series,
      n,
      step,
      holes,
      start: Math.min(base[0]?.t ?? Infinity, audio[0]?.t ?? Infinity),
      end: Math.max(base[n - 1]?.t ?? 0, audio[audio.length - 1]?.t ?? 0),
      totalSec,
      activeSec,
      hiddenSec,
      cont,
      limit,
      events,
      up,
      down: dn,
      stops: events.filter((e) => e.kind === 'stop'),
      reconnects: pcs.length - 1,
      disconnects: events.filter((e) => e.kind === 'disconnect').length,
      topRid,
      layers: ranked.map(([rid, arr]) => ({
        rid,
        res: resLabel(median(pick(arr, 'w')), median(pick(arr, 'h'))),
        bps: R.weightedMean(arr, 'bps', startT),
        fps: median(pick(arr, 'fps')),
        sec: after(arr).filter((s) => num(s.bps) && s.bps > 0).reduce((a, s) => a + s._dt, 0),
      })),
      avgBps: weightedMeanSeries(series.bps),
      avgAudioBps: R.weightedMean(audio, 'bps', startT),
      avgTargetBps: R.weightedMean(video, 'targetBps', startT),
      availBps: median(pick(base, 'availOutBps')),
      res: resLabel(median(pick(video, 'w')), median(pick(video, 'h'))),
      src: resLabel(srcW, srcH),
      srcFps: median(pick(video, 'srcFps')),
      encodeMs: median(pick(video, 'encodeMs')),
      codecs: {
        video: [...new Set(video.map((s) => s.codec).filter(Boolean))],
        audio: [...new Set(audio.map((s) => s.codec).filter(Boolean))],
      },
      resolutions: [...resolutions].map(([res, sec]) => ({ res, sec })).sort((a, b) => b.sec - a.sec),
      ...R.routeShare(base, startT),
      requests: {
        nack: sum(video, 'nack') + sum(audio, 'nack'),
        pli: sum(video, 'pli'),
        fir: sum(video, 'fir'),
        rtx: sum(video, 'rtx') + sum(audio, 'rtx'),
        keyFrames: sum(video, 'keyFrames'),
      },
      silentRatio: lvSec ? silentSec / lvSec : null,
      verdict,
    };
  }

  /** 同じ時刻の値を足し合わせた系列（サイマルキャストの全レイヤー合計） */
  function sumByTime(arrs, f, startT) {
    const at = new Map();
    for (const arr of arrs) {
      for (const s of arr) {
        if (!num(s[f])) continue;
        const e = at.get(s.t);
        if (e) e.v += s[f];
        else at.set(s.t, { t: s.t, pc: s.pc, w: s._dt, v: s[f] });
      }
    }
    return [...at.values()].sort((a, b) => a.t - b.t).map((e) => (e.t >= startT ? e : { ...e, v: null }));
  }

  /** 同じ時刻の値のうち大きい方をとった系列 */
  function maxByTime(arrs, f, startT) {
    const at = new Map();
    for (const arr of arrs) {
      for (const s of arr) {
        if (s.t < startT || !num(s[f])) continue;
        const e = at.get(s.t);
        if (e) e.v = Math.max(e.v, s[f]);
        else at.set(s.t, { t: s.t, pc: s.pc, w: s._dt, v: s[f] });
      }
    }
    return [...at.values()].sort((a, b) => a.t - b.t);
  }

  function weightedMeanSeries(pts) {
    let sum = 0, w = 0;
    for (const q of pts) {
      if (q.v == null) continue;
      sum += q.v * q.w;
      w += q.w;
    }
    return w ? sum / w : null;
  }

  function resLabel(w, h) {
    return num(w) && num(h) && w && h ? `${Math.round(w)}×${Math.round(h)}` : null;
  }

  // ------------------------------------------------------------ 描画

  const compare = {
    heads: ['送信時間', '品質制限', '平均ビットレート', '送信解像度'],
    cells: (p) => [dur(p.activeSec), pct(p.limit.ratio), bps(p.avgBps ?? p.avgAudioBps), p.res || '—'],
  };

  function summary(p, cfg, withBadge) {
    const findings = findingsOf(p, cfg);
    const lead = R.leadText(
      p.verdict,
      '送信',
      p.activeSec,
      findings.filter((f) => f.lv === LV.crit).length,
      findings.filter((f) => f.lv === LV.warn).length
    );
    const notes = [];
    if (p.reconnects) notes.push(`接続が ${p.reconnects} 回張り直されました（再接続）。途切れていた時間はイベント一覧にあります。`);
    if (p.disconnects) notes.push(`接続が切れかけた（disconnected / failed）区間が ${p.disconnects} 回ありました。`);
    if (p.stops.length) notes.push(`接続中に映像の送信がほぼ止まった区間が ${p.stops.length} 回（合計 ${fix(p.stops.reduce((a, e) => a + e.sec, 0), 1)} 秒）ありました。カメラの停止や映像 OFF の操作でも起きます。`);
    if (p.down > 0) notes.push(`送信解像度の引き下げが ${p.down} 回ありました（引き上げ ${p.up} 回）。`);
    if (p.requests.pli > 0) notes.push(`受け手からキーフレーム要求（PLI）が ${p.requests.pli} 回届きました。受け手側で映像が欠けていた目安です。`);
    if (p.silentRatio != null && p.silentRatio > 0.1) notes.push(`マイクの入力が無音だった時間が ${pct(p.silentRatio)} あります。ミュートしていたか、入力デバイスを確認してください。`);
    return R.summarySection({ verdict: p.verdict, lead, findings, notes, withBadge });
  }

  function findingsOf(p, cfg) {
    const th = cfg.thresholds;
    const out = [];
    const c = p.cont;
    const lim = (key, lv) => th[key][R.lvKey(lv)];

    const L = p.limit;
    if (L.level) {
      const cpu = L.cpuSec >= L.bwSec;
      const active = Math.max(L.baseSec, 1);
      let text = `送信品質に制限がかかっていた時間が ${pct(L.ratio)}（CPU ${pct(L.cpuSec / active)} / 帯域 ${pct(L.bwSec / active)}）あり、${R.lvName(L.level)}（${lim('limitPct', L.level)}%）以上でした。`;
      text += cpu
        ? `主に CPU 不足で、エンコーダが解像度やフレームレートを落としています${p.encodeMs != null ? `（1フレームのエンコードに中央値 ${fix(p.encodeMs, 1)} ms）` : ''}。配信する端末の負荷を下げるか、エンコード設定を軽くしてください。`
        : `主に上り帯域の不足で、送信ビットレートを絞っています${p.availBps != null ? `（推定上り帯域の中央値 ${bps(p.availBps)}）` : ''}。配信する回線を確認してください。`;
      const mins = p.events.filter((e) => e.kind === 'limit' && e.minRes).map((e) => e.minRes);
      if (p.src && mins.length) {
        const m = mins.reduce((a, b) => (b.w * b.h < a.w * a.h ? b : a));
        text += `その間、解像度は元の ${p.src} に対して最小 ${m.w}×${m.h} まで下がりました。`;
      }
      out.push({ lv: L.level, text });
    }
    if (c.fps.level) {
      const camLow = p.srcFps != null && R.levelOf(th.fps, p.srcFps) > LV.ok;
      out.push({
        lv: c.fps.level,
        text:
          `送信映像のフレームレートの下位5%値が ${fix(c.fps.rep, 1)} fps で、${R.lvName(c.fps.level)}（${lim('fps', c.fps.level)} fps）以下でした。` +
          (camLow
            ? `カメラ（キャプチャ）の fps も中央値 ${fix(p.srcFps, 1)} fps と低く、入力の時点で不足しています。カメラの設定や照明（暗いと fps が落ちる機種がある）を確認してください。`
            : p.limit.cpuSec > p.limit.bwSec && p.limit.cpuSec > 0
              ? 'カメラの fps は足りており、CPU 不足によるエンコーダの間引きが原因と考えられます。'
              : 'カメラの fps は足りており、送信の過程でフレームが間引かれています。品質制限や送信停止の区間と照らし合わせてください。'),
      });
    }
    if (c.lossPct.level) {
      out.push({
        lv: c.lossPct.level,
        text: `受け手から報告されたパケットロス率の上位5%値が ${fix(c.lossPct.rep, 2)}% で、${R.lvName(c.lossPct.level)}（${lim('lossPct', c.lossPct.level)}%）以上でした。送信者から受け手までの経路（SFU や配信サーバーを経由する場合はサーバーまでの上り区間）で損失が起きています。`,
      });
    }
    if (c.rttMs.level) {
      out.push({
        lv: c.rttMs.level,
        text:
          `往復遅延（RTT）の上位5%値が ${fix(c.rttMs.rep, 0)} ms で、${R.lvName(c.rttMs.level)}（${lim('rttMs', c.rttMs.level)} ms）以上でした。` +
          (p.relayRatio ? `経路が relay（TURN 経由）だった時間が ${pct(p.relayRatio)} あります。` : '') +
          '経路が長いか、上り回線が混雑しています。',
      });
    }
    return out.sort((a, b) => b.lv - a.lv);
  }

  function kpi(p) {
    const c = p.cont;
    const L = p.limit;
    const active = Math.max(L.baseSec, 1);
    return R.kpiSection([
      ['送信時間', dur(p.activeSec), `記録 ${dur(p.totalSec)}`, null],
      p.video.length
        ? ['平均ビットレート（映像）', bps(p.avgBps), p.avgAudioBps != null ? `音声 ${bps(p.avgAudioBps)}` : '', null]
        : ['平均ビットレート（音声）', bps(p.avgAudioBps), '映像の送信なし', null],
      ['送信解像度', p.res || '—', p.src ? `元 ${p.src}` : '', null],
      ['フレームレート', c.fps.n ? `${fix(c.fps.median, 1)} fps` : '—', c.fps.n ? `下位5% ${fix(c.fps.rep, 1)} fps` : '', c.fps.level],
      ['品質制限', pct(L.ratio), L.ratio != null ? `CPU ${pct(L.cpuSec / active)} / 帯域 ${pct(L.bwSec / active)}` : '', L.level],
      ['パケットロス率', c.lossPct.n ? `${fix(c.lossPct.mean, 2)}%` : '—', c.lossPct.n ? `上位5% ${fix(c.lossPct.rep, 2)}%` : '', c.lossPct.level],
      ['RTT', c.rttMs.n ? `${fix(c.rttMs.median, 0)} ms` : '—', c.rttMs.n ? `上位5% ${fix(c.rttMs.rep, 0)} ms` : '', c.rttMs.level],
      ['受け手からの要求', `PLI ${p.requests.pli} 回`, `NACK ${p.requests.nack} / 再送 ${p.requests.rtx} パケット`, null],
    ]);
  }

  function judgement(p, cfg) {
    const th = cfg.thresholds;
    const L = p.limit;
    const active = Math.max(L.baseSec, 1);
    return R.judgementSection([
      [
        '品質制限（CPU・帯域）',
        L.ratio != null ? `${fix(L.ratio * 100, 1)} %（期間中の割合）` : '—',
        R.limits(th.limitPct, '%'),
        '—',
        L.ratio != null ? `CPU ${fix(L.cpuSec, 0)} 秒（${pct(L.cpuSec / active)}）/ 帯域 ${fix(L.bwSec, 0)} 秒（${pct(L.bwSec / active)}）` : 'データなし',
        L.ratio != null ? L.level : null,
      ],
      ...CONT.map((m) => R.contRow(m, p.cont[m.key], th[m.key])),
    ]);
  }

  function charts(p, cfg) {
    const c = cfg.report.sendCharts;
    const th = cfg.thresholds;
    const s = p.series;
    const bands = p.events.filter((e) => e.kind === 'limit' || e.kind === 'stop');
    const marks = p.events.filter((e) => e.kind === 'reconnect' || e.kind === 'disconnect').map((e) => e.t);
    const list = [];
    if (c.bitrate && p.video.length) {
      list.push({
        title: '送信ビットレート（映像・全レイヤー合計、Mbps）',
        series: [
          { pts: s.bps, cls: 's1', scale: 1e-6, name: '送信' },
          { pts: s.availBps, cls: 's2', scale: 1e-6, name: '推定上り帯域' },
        ],
        bands,
        marks,
      });
    }
    if (c.fps && p.video.length) {
      list.push({
        title: 'フレームレート（fps）',
        series: [
          { pts: s.fps, cls: 's1', name: '送信' },
          { pts: s.srcFps, cls: 's2', name: 'カメラ' },
        ],
        th: th.fps,
        bands,
        marks,
      });
    }
    if (c.loss) list.push({ title: 'パケットロス率（受け手の報告、%、20% で頭打ち）', series: [{ pts: s.lossPct, cls: 's1' }], th: th.lossPct, cap: 20, bands, marks });
    if (c.rtt) list.push({ title: '往復遅延 RTT（ms）', series: [{ pts: s.rttMs, cls: 's1' }], th: th.rttMs, bands, marks });
    return R.chartsSection(p, list, '<span class="lg band"></span>品質制限・送信停止 <span class="lg err"></span>再接続・切断');
  }

  const EVENT_DEFS = {
    limit: ['品質制限', 'warn'],
    stop: ['送信停止', 'crit'],
    reconnect: ['再接続', 'crit'],
    disconnect: ['切断', 'crit'],
    resUp: ['解像度↑', ''],
    resDown: ['解像度↓', 'warn'],
    route: ['経路変更', ''],
  };
  const REASON = { cpu: 'CPU', bandwidth: '帯域' };

  function eventList(p) {
    const detail = (e) => {
      if (e.kind === 'limit') return `${REASON[e.reason]}　${fix(e.sec, 0)} 秒${e.minRes ? `　最小 ${e.minRes.w}×${e.minRes.h}` : ''}`;
      if (e.kind === 'stop') return `${fix(e.sec, 0)} 秒`;
      if (e.kind === 'resUp' || e.kind === 'resDown') return `${e.from} → ${e.to}${e.reason ? `（${REASON[e.reason] || e.reason}による制限中）` : ''}`;
      return R.commonDetail(e);
    };
    return R.eventSection(p.events, EVENT_DEFS, detail, '品質制限・送信停止・再接続・切断・解像度の変化・経路の切り替えはありませんでした。');
  }

  function stream(p) {
    const rq = p.requests;
    const routeTotal = p.routes.reduce((a, x) => a + x.sec, 0) || 1;
    // レイヤーは同時に送るものなので、割合ではなく送信していた時間そのものを出す
    const layers =
      p.layers.length > 1
        ? R.table(
            ['レイヤー（rid）', '解像度（中央値）', '平均ビットレート', 'fps（中央値）', '送信していた時間'],
            p.layers.map((l) => [`${l.rid || '—'}${l.rid === p.topRid ? '（評価対象）' : ''}`, l.res || '—', bps(l.bps), fix(l.fps, 1), dur(l.sec)])
          )
        : '';
    return R.kvSection(
      '送信ストリーム',
      [
        ['映像コーデック', p.codecs.video.join(', ') || '—'],
        ['音声コーデック', p.codecs.audio.join(', ') || '—'],
        ['平均ビットレート', `映像 ${bps(p.avgBps)} / 音声 ${bps(p.avgAudioBps)}`],
        ['目標ビットレート', `${bps(p.avgTargetBps)}（エンコーダの目標、平均）`],
        ['推定上り帯域', `${bps(p.availBps)}（中央値）`],
        ['送信元', `${p.src || '—'} / カメラ ${fix(p.srcFps, 1)} fps（中央値）`],
        ['エンコード時間', p.encodeMs != null ? `${fix(p.encodeMs, 2)} ms / フレーム（中央値）` : '—'],
        ['接続', `${p.pcs.join(' → ')}${p.reconnects ? `（再接続 ${p.reconnects} 回）` : ''}`],
        ['経路', p.routes.length ? p.routes.map((r) => `${r.route} ${pct(r.sec / routeTotal)}`).join(' / ') : '—'],
        ['受け手からの要求', `NACK ${rq.nack} / PLI ${rq.pli} / FIR ${rq.fir}`],
        ['再送・キーフレーム', `再送 ${rq.rtx} パケット / キーフレーム ${rq.keyFrames} 枚`],
        ['マイクの無音', p.silentRatio != null ? `${pct(p.silentRatio)}（入力レベル ${SILENT_LEVEL} 未満の時間）` : '—'],
      ],
      layers + R.shareTable(['送信解像度' + (p.layers.length > 1 ? '（評価対象のレイヤー）' : ''), '送信時間の割合'], p.resolutions.map((v) => [v.res, v.sec]))
    );
  }

  function conditions(p, session, other) {
    return R.kvSection('計測条件', [
      ['対象ホスト', session.host],
      ['ブラウザ', session.browser || '記録なし'],
      ['記録期間', `${stamp(p.start)} 〜 ${stamp(p.end)}（${dur(p.totalSec)}）`],
      ['サンプル', `${p.n} 件 / 間隔 ${fix(p.step / 1000, 1)} 秒${p.holes ? `（記録の欠け ${p.holes} 箇所）` : ''}`],
      ['送信していない時間', `${dur(Math.max(0, p.totalSec - p.activeSec))}（接続前・切断中を含む）`],
      ['タブ非表示', dur(p.hiddenSec)],
      ['評価の対象', `送信のみ${other ? '（受信したストリームは対象外）' : ''}`],
      ['評価したレイヤー', p.layers.length > 1 ? `${p.topRid || '—'}（全 ${p.layers.length} レイヤーのうち最も解像度の高いもの）` : '単一'],
      ['計測した拡張', session.version ? `v${session.version}` : '0.6.0 より前'],
    ]);
  }

  function criteria(cfg) {
    const th = cfg.thresholds;
    return R.criteriaSection(
      'しきい値は WebRTC Analyzer の設定画面の値です。連続値は送信開始後のサンプルだけを使い、一時的な跳ねで判定が振れないよう分布の端（5%点）をしきい値と比べます。パケットロス率と RTT は受け手からの受信報告（RTCP）に基づき、SFU や配信サーバーを経由する場合はサーバーまでの区間の値です。重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外を「良好」とします。',
      [
        ['品質制限', th.limitPct, '%', '期間中に CPU・帯域の制限がかかっていた時間の割合（映像）'],
        ['フレームレート', th.fps, 'fps', '下位5%値（送信映像。サイマルキャストは最上位レイヤー）'],
        ['パケットロス率', th.lossPct, '%', '上位5%値（受け手の報告。映像と音声の悪い方）'],
        ['往復遅延（RTT）', th.rttMs, 'ms', '上位5%値'],
      ]
    );
  }

  (globalThis.WRA_REPORT_KINDS ||= {}).out = {
    label: '送信',
    title: (cfg) => cfg.report.sendTitle,
    scope: (other) => `送信した映像・音声${other ? '（受信したストリームは対象外）' : ''}`,
    empty: (other) => `送信した映像・音声の記録がありません。${other ? '受信だけのセッションは、受信品質レポートで評価してください。' : ''}`,
    footer: '数値はブラウザの getStats() による送信側の実測と、受け手からの受信報告（RTCP）です。受け手や配信サーバー側の記録とは一致しない場合があります。',
    filePrefix: 'webrtc-send-report',
    analyzeSession,
    compare,
    sections: { summary, kpi, judgement, charts, events: eventList, stream, conditions, criteria },
  };
})();

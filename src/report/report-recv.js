/*
 * WebRTC Analyzer — 受信品質レポート（report.html?dir=in）
 *
 * 評価の対象は受信（inbound）だけ。送信したストリームの行は読み飛ばす。
 *
 * 集計の単位は「視聴」。1セッション（1ページ）の中で、時間の重ならない PeerConnection は
 * 再接続とみなして1つの視聴につなぐ。同時に張られていた PeerConnection は別の視聴として扱う。
 * 1つの PeerConnection に同じ種類の受信が複数ある（会議など）ときは、サンプル数の
 * 最も多いもの（mid 単位）を評価し、ほかは件数だけ計測条件に出す。
 *
 * 判定（しきい値は設定画面の値）
 *   - 連続値（ジッターバッファ・ロス率・fps・音声の補間率・RTT）
 *       上位5%値、低いほど悪い fps は下位5%値をしきい値と比べる。
 *       受信開始前（最初に connected でビットレートが出るまで）のサンプルは除く。
 *   - 回数（フリーズ）
 *       期間中の合計回数をしきい値と比べる。タブが非表示の間は数えない。
 */
(() => {
  'use strict';

  const R = WRA_REPORT;
  const { LV, num, median, fix, pct, bps, dur, stamp, esc } = R;

  /** 連続値の指標。key は cfg.thresholds と p.series のキー */
  const CONT = [
    { key: 'bufferMs', label: 'ジッターバッファ遅延', unit: 'ms', digits: 0 },
    { key: 'lossPct', label: 'パケットロス率', unit: '%', digits: 2 },
    { key: 'fps', label: 'フレームレート（映像）', unit: 'fps', digits: 1 },
    { key: 'concealPct', label: '音声の補間率', unit: '%', digits: 2 },
    { key: 'rttMs', label: '往復遅延（RTT）', unit: 'ms', digits: 0 },
  ];

  // ------------------------------------------------------------ 集計

  function analyzeSession(rows, cfg) {
    const { other, units } = R.groupByConnection(rows, 'in', (meta, s) => s.mid ?? '');
    const all = units.map((pcs) => analyze(pcs, cfg));
    // 受信が一度も始まらなかったもの（接続だけ張られた予備の PC など）は落とす。全滅なら一番長いものだけ残す
    const live = all.filter((p) => p.activeSec > 0);
    const items = live.length ? live.sort((a, b) => a.start - b.start) : all.sort((a, b) => b.n - a.n).slice(0, 1);
    return { other, items };
  }

  function analyze(pcs, cfg) {
    // 種類ごとに、PeerConnection の中で一番サンプルの多いストリーム（mid）を評価対象にする
    const video = [];
    const audio = [];
    const extra = { video: 0, audio: 0 };
    for (const pc of pcs) {
      for (const kind of ['video', 'audio']) {
        const groups = Object.values(pc.rows[kind]).sort((a, b) => b.length - a.length);
        if (!groups.length) continue;
        extra[kind] = Math.max(extra[kind], groups.length - 1);
        (kind === 'video' ? video : audio).push(...groups[0]);
      }
    }
    video.sort((a, b) => a.t - b.t);
    audio.sort((a, b) => a.t - b.t);

    // 時間の重みは映像を基準にする（音声だけの受信なら音声）
    const base = video.length ? video : audio;
    const { step, holes } = R.weigh(base);
    if (base !== audio) R.weigh(audio);
    const n = base.length;

    let totalSec = 0, activeSec = 0, hiddenSec = 0;
    for (const s of base) {
      totalSec += s._dt;
      if (s.state === 'connected' && num(s.bps) && s.bps > 0) activeSec += s._dt;
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
    for (const m of CONT) cont[m.key] = R.seriesStats(series[m.key], th[m.key]);

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
    fz.level = R.levelOf(th.freeze, fz.total);

    events.push(...R.reconnectEvents(pcs), ...R.connectionEvents(base));

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
      activeSec,
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
      avgBps: R.weightedMean(video, 'bps', startT),
      avgAudioBps: R.weightedMean(audio, 'bps', startT),
      jitter: { video: median(pick(video, 'jitterMs')), audio: median(pick(audio, 'jitterMs')) },
      decodeMs: median(pick(video, 'decodeMs')),
      codecs: {
        video: [...new Set(video.map((s) => s.codec).filter(Boolean))],
        audio: [...new Set(audio.map((s) => s.codec).filter(Boolean))],
      },
      resolutions: [...resolutions].map(([res, sec]) => ({ res, sec })).sort((a, b) => b.sec - a.sec),
      ...R.routeShare(base, startT),
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

  /** 冒頭の比較表の列 */
  const compare = {
    heads: ['受信時間', 'フリーズ', 'パケットロス率', '平均ビットレート'],
    cells: (p) => [dur(p.activeSec), `${p.freeze.total} 回 / ${fix(p.freeze.sec, 1)} 秒`, pct(p.loss.all, 2), bps(p.avgBps ?? p.avgAudioBps)],
  };

  function summary(p, cfg, withBadge) {
    const findings = findingsOf(p, cfg);
    const lead = R.leadText(
      p.verdict,
      '受信',
      p.activeSec,
      findings.filter((f) => f.lv === LV.crit).length,
      findings.filter((f) => f.lv === LV.warn).length
    );
    const notes = [];
    if (p.reconnects) notes.push(`接続が ${p.reconnects} 回張り直されました（再接続）。途切れていた時間はイベント一覧にあります。`);
    if (p.disconnects) notes.push(`接続が切れかけた（disconnected / failed）区間が ${p.disconnects} 回ありました。`);
    if (p.pause.total) notes.push(`5秒以上映像が届かない途切れが ${p.pause.total} 回（合計 ${fix(p.pause.sec, 1)} 秒）ありました。`);
    if (p.down > 0) notes.push(`受信解像度の引き下げが ${p.down} 回ありました（引き上げ ${p.up} 回）。`);
    if (p.hiddenSec > p.totalSec * 0.1) notes.push(`タブが非表示だった時間が ${pct(p.hiddenSec / p.totalSec)} あり、その間のフレームレートとフリーズは集計から除いています。`);
    return R.summarySection({ verdict: p.verdict, lead, findings, notes, withBadge });
  }

  function findingsOf(p, cfg) {
    const th = cfg.thresholds;
    const out = [];
    const c = p.cont;
    const lim = (key, lv) => th[key][R.lvKey(lv)];

    const fz = p.freeze;
    if (fz.level) {
      const causes = p.events.filter((e) => e.kind === 'freeze').map((e) => e.cause);
      const cnt = (x) => causes.filter((y) => y === x).length;
      let text = `映像のフリーズが ${fz.total} 回（合計 ${fix(fz.sec, 1)} 秒、受信時間の ${pct(fz.sec / Math.max(p.activeSec, 1))}）発生しました。`;
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
          `パケットロス率の上位5%値が ${fix(c.lossPct.rep, 2)}% で、${R.lvName(c.lossPct.level)}（${lim('lossPct', c.lossPct.level)}%）以上でした。` +
          (p.loss.all != null ? `期間全体の損失率は ${pct(p.loss.all, 2)} です。` : '') +
          '回線または配信経路で損失が起きています。',
      });
    }
    if (c.bufferMs.level) {
      out.push({
        lv: c.bufferMs.level,
        text: `ジッターバッファ遅延の上位5%値が ${fix(c.bufferMs.rep, 0)} ms で、${R.lvName(c.bufferMs.level)}（${lim('bufferMs', c.bufferMs.level)} ms）以上でした（警告値以上だった時間 ${pct(c.bufferMs.warnRatio)}）。到着の揺らぎを吸収するために受信側が遅延を積み増しており、その分だけ映像が遅れて表示されます。`,
      });
    }
    if (c.fps.level) {
      const slowDecode = p.decodeMs != null && c.fps.median > 0 && p.decodeMs > (1000 / c.fps.median) * 0.5;
      out.push({
        lv: c.fps.level,
        text:
          `受信映像のフレームレートの下位5%値が ${fix(c.fps.rep, 1)} fps で、${R.lvName(c.fps.level)}（${lim('fps', c.fps.level)} fps）以下でした（タブ非表示中を除く）。` +
          (slowDecode
            ? `1フレームのデコードに中央値で ${fix(p.decodeMs, 1)} ms かかっており、端末の処理能力不足が疑われます。`
            : '送信側でフレームを間引いているか、受信が途切れがちだったと考えられます。配信側の設定 fps も確認してください。'),
      });
    }
    if (c.concealPct.level) {
      out.push({
        lv: c.concealPct.level,
        text: `音声の補間率の上位5%値が ${fix(c.concealPct.rep, 2)}% で、${R.lvName(c.concealPct.level)}（${lim('concealPct', c.concealPct.level)}%）以上でした。届かなかった音声を推測で埋めた区間があり、途切れやノイズとして聞こえた可能性があります。`,
      });
    }
    if (c.rttMs.level) {
      out.push({
        lv: c.rttMs.level,
        text:
          `往復遅延（RTT）の上位5%値が ${fix(c.rttMs.rep, 0)} ms で、${R.lvName(c.rttMs.level)}（${lim('rttMs', c.rttMs.level)} ms）以上でした。` +
          (p.relayRatio ? `経路が relay（TURN 経由）だった時間が ${pct(p.relayRatio)} あります。` : '') +
          '経路が長いか、途中で混雑しています。',
      });
    }
    return out.sort((a, b) => b.lv - a.lv);
  }

  function kpi(p) {
    const c = p.cont;
    const fz = p.freeze;
    return R.kpiSection([
      ['受信時間', dur(p.activeSec), `記録 ${dur(p.totalSec)}`, null],
      ['フリーズ', `${fz.total} 回`, `${fix(fz.sec, 1)} 秒 / 受信時間の ${pct(fz.sec / Math.max(p.activeSec, 1))}`, fz.level],
      ['パケットロス率', pct(p.loss.all, 2), c.lossPct.n ? `上位5% ${fix(c.lossPct.rep, 2)}%` : '', c.lossPct.level],
      p.avgBps != null
        ? ['平均ビットレート（映像）', bps(p.avgBps), p.avgAudioBps != null ? `音声 ${bps(p.avgAudioBps)}` : '', null]
        : ['平均ビットレート（音声）', bps(p.avgAudioBps), '映像の受信なし', null],
      ['フレームレート', c.fps.n ? `${fix(c.fps.median, 1)} fps` : '—', c.fps.n ? `下位5% ${fix(c.fps.rep, 1)} fps` : '', c.fps.level],
      ['ジッターバッファ', c.bufferMs.n ? `${fix(c.bufferMs.median, 0)} ms` : '—', c.bufferMs.n ? `上位5% ${fix(c.bufferMs.rep, 0)} ms` : '', c.bufferMs.level],
      ['音声の補間率', c.concealPct.n ? `${fix(c.concealPct.mean, 2)}%` : '—', c.concealPct.n ? `上位5% ${fix(c.concealPct.rep, 2)}%` : '', c.concealPct.level],
      ['RTT', c.rttMs.n ? `${fix(c.rttMs.median, 0)} ms` : '—', c.rttMs.n ? `上位5% ${fix(c.rttMs.rep, 0)} ms` : '', c.rttMs.level],
    ]);
  }

  function judgement(p, cfg) {
    const th = cfg.thresholds;
    return R.judgementSection([
      ...CONT.map((m) => R.contRow(m, p.cont[m.key], th[m.key])),
      ['フリーズ', `${p.freeze.total} 回（合計）`, R.limits(th.freeze, '回'), '—', `合計 ${fix(p.freeze.sec, 1)} 秒`, p.freeze.level],
    ]);
  }

  function charts(p, cfg) {
    const c = cfg.report.charts;
    const th = cfg.thresholds;
    const s = p.series;
    const bands = p.events.filter((e) => e.kind === 'freeze' || e.kind === 'pause');
    const marks = p.events.filter((e) => e.kind === 'reconnect' || e.kind === 'disconnect').map((e) => e.t);
    const one = (title, pts, opt = {}) => ({ title, series: [{ pts, cls: 's1', scale: opt.scale }], th: opt.th, cap: opt.cap, bands, marks });
    const list = [];
    if (c.bitrate && p.video.length) list.push(one('受信ビットレート（映像、Mbps）', s.bps, { scale: 1e-6 }));
    if (c.fps && p.video.length) list.push(one('フレームレート（fps、タブ非表示中を除く）', s.fps, { th: th.fps }));
    if (c.buffer) list.push(one('ジッターバッファ遅延（ms）', s.bufferMs, { th: th.bufferMs }));
    if (c.loss) list.push(one('パケットロス率（%、20% で頭打ち）', s.lossPct, { th: th.lossPct, cap: 20 }));
    if (c.rtt) list.push(one('往復遅延 RTT（ms）', s.rttMs, { th: th.rttMs }));
    if (c.conceal && p.audio.length) list.push(one('音声の補間率（%、50% で頭打ち）', s.concealPct, { th: th.concealPct, cap: 50 }));
    return R.chartsSection(p, list, '<span class="lg band"></span>フリーズ・途切れ <span class="lg err"></span>再接続・切断');
  }

  const EVENT_DEFS = {
    freeze: ['フリーズ', 'warn'],
    pause: ['途切れ', 'crit'],
    reconnect: ['再接続', 'crit'],
    disconnect: ['切断', 'crit'],
    resUp: ['解像度↑', ''],
    resDown: ['解像度↓', 'warn'],
    route: ['経路変更', ''],
  };

  function eventList(p) {
    const detail = (e) => {
      if (e.kind === 'freeze') return `${e.sec != null ? `${fix(e.sec, 2)} 秒` : ''}${e.n > 1 ? `（${e.n} 回）` : ''}${e.cause ? `　推定原因: ${e.cause}` : ''}`;
      if (e.kind === 'pause') return e.sec != null ? `${fix(e.sec, 1)} 秒` : '';
      return R.commonDetail(e);
    };
    return R.eventSection(p.events, EVENT_DEFS, detail, 'フリーズ・途切れ・再接続・切断・解像度の変化・経路の切り替えはありませんでした。');
  }

  function stream(p) {
    const rc = p.recovery;
    const routeTotal = p.routes.reduce((a, x) => a + x.sec, 0) || 1;
    return R.kvSection(
      '受信ストリーム',
      [
        ['映像コーデック', p.codecs.video.join(', ') || '—'],
        ['音声コーデック', p.codecs.audio.join(', ') || '—'],
        ['平均ビットレート', `映像 ${bps(p.avgBps)} / 音声 ${bps(p.avgAudioBps)}`],
        ['接続', `${p.pcs.join(' → ')}${p.reconnects ? `（再接続 ${p.reconnects} 回）` : ''}`],
        ['経路', p.routes.length ? p.routes.map((r) => `${r.route} ${pct(r.sec / routeTotal)}`).join(' / ') : '—'],
        ['ジッター', `映像 ${fix(p.jitter.video, 1)} ms / 音声 ${fix(p.jitter.audio, 1)} ms（中央値）`],
        ['デコード時間', p.decodeMs != null ? `${fix(p.decodeMs, 2)} ms / フレーム（中央値）` : '—'],
        ['期間全体の損失率', `映像 ${pct(p.loss.video, 2)} / 音声 ${pct(p.loss.audio, 2)}`],
        ['再送・回復（映像）', `NACK ${rc.nack} / 再送で回復 ${rc.rtx} / PLI ${rc.pli} / FIR ${rc.fir}`],
        ['捨てた量', `表示しなかったフレーム ${rc.dropped} / 破棄パケット ${rc.discarded}`],
      ],
      R.shareTable(['受信解像度', '受信時間の割合'], p.resolutions.map((v) => [v.res, v.sec]))
    );
  }

  function conditions(p, session, other) {
    const others = [];
    if (p.extra.video) others.push(`映像 ${p.extra.video} 本`);
    if (p.extra.audio) others.push(`音声 ${p.extra.audio} 本`);
    return R.kvSection('計測条件', [
      ['対象ホスト', session.host],
      ['ブラウザ', session.browser || '記録なし'],
      ['記録期間', `${stamp(p.start)} 〜 ${stamp(p.end)}（${dur(p.totalSec)}）`],
      ['サンプル', `${p.n} 件 / 間隔 ${fix(p.step / 1000, 1)} 秒${p.holes ? `（記録の欠け ${p.holes} 箇所）` : ''}`],
      ['受信していない時間', `${dur(Math.max(0, p.totalSec - p.activeSec))}（接続前・切断中を含む）`],
      ['タブ非表示', `${dur(p.hiddenSec)}（フレームレートとフリーズの集計から除外）`],
      ['評価の対象', `受信のみ${other ? '（送信したストリームは対象外）' : ''}`],
      ['集計外の受信', others.length ? `${others.join('・')}（同じ接続で並行して受信していたもの）` : 'なし'],
      ['計測した拡張', session.version ? `v${session.version}` : '0.6.0 より前'],
    ]);
  }

  function criteria(cfg) {
    const th = cfg.thresholds;
    return R.criteriaSection(
      'しきい値は WebRTC Analyzer の設定画面の値です。連続値は受信開始後のサンプルだけを使い、一時的な跳ねで判定が振れないよう分布の端（5%点）をしきい値と比べます。重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外を「良好」とします。ジッター（到着間隔のばらつき）は参考値として受信ストリームの章に載せ、判定には使いません。',
      [
        ['フリーズ', th.freeze, '回', '期間中の合計（タブ非表示中を除く）'],
        ['パケットロス率', th.lossPct, '%', '上位5%値（サンプルごと、映像と音声の合算）'],
        ['ジッターバッファ遅延', th.bufferMs, 'ms', '上位5%値（映像。映像が無ければ音声）'],
        ['フレームレート', th.fps, 'fps', '下位5%値（映像、タブ非表示中を除く）'],
        ['音声の補間率', th.concealPct, '%', '上位5%値'],
        ['往復遅延（RTT）', th.rttMs, 'ms', '上位5%値'],
      ]
    );
  }

  (globalThis.WRA_REPORT_KINDS ||= {}).in = {
    label: '受信',
    title: (cfg) => cfg.report.title,
    scope: (other) => `受信した映像・音声${other ? '（送信したストリームは対象外）' : ''}`,
    empty: (other) => `受信した映像・音声の記録がありません。${other ? '送信だけのセッションは、送信品質レポートで評価してください。' : ''}`,
    footer: '数値はブラウザの getStats() による受信側の実測で、配信サーバーや送信側の記録とは一致しない場合があります。',
    filePrefix: 'webrtc-recv-report',
    analyzeSession,
    compare,
    sections: { summary, kpi, judgement, charts, events: eventList, stream, conditions, criteria },
  };
})();

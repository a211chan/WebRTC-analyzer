/*
 * WebRTC Analyzer — 品質レポートの共通部品
 *
 * 受信レポート（report-recv.js）と送信レポート（report-send.js）の両方から使う。
 * 集計の小道具（重み付け・分位点・しきい値判定）と、章の枠組み（表紙・判定表・グラフ・一覧）を持つ。
 * どちらのレポートも「判定は設定画面のしきい値だけを使う」「連続値は分布の端（5%点）で比べる」
 * という同じ考え方に立つので、その部分はここに1つだけ置く。
 */
(() => {
  if (globalThis.WRA_REPORT) return;

  const { localStamp } = WRA_EXPORT;

  /** 判定の段階 */
  const LV = { ok: 0, warn: 1, crit: 2 };
  const VERDICT = [
    { key: 'ok', label: '良好' },
    { key: 'warn', label: '注意' },
    { key: 'crit', label: '不良' },
  ];

  // ------------------------------------------------------------ 集計

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

  /**
   * サンプルごとの重み（秒）を s._dt に入れる。中央値の3倍を超える間は「記録の欠け」とみなし、
   * 重みに数えない。PeerConnection（s.pc）の切り替わりは欠けではなく再接続として別に数える。
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

  /** 接続中の時間で重み付けした平均。startT より前は数えない */
  function weightedMean(arr, f, startT) {
    let sum = 0, w = 0;
    for (const s of arr) {
      if (s.t < startT || s.state !== 'connected' || !num(s[f])) continue;
      sum += s[f] * s._dt;
      w += s._dt;
    }
    return w ? sum / w : null;
  }

  /** 連続値の統計と判定。低いほど悪い指標（dir: 'below'）は下位5%値、ほかは上位5%値を比べる */
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

  /** 系列（{ v, w } の配列。v が null の点は飛ばす）から contStats を出す */
  function seriesStats(pts, t) {
    const ok = pts.filter((q) => q.v != null);
    return contStats(
      ok.map((q) => q.v),
      ok.map((q) => q.w),
      t
    );
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
   * 1セッション（1ページ）の行を、指定した向きのストリームだけ PeerConnection ごとに束ね、
   * 時間の重ならない PeerConnection を再接続とみなして「視聴（送信なら配信）」の単位につなぐ。
   * 返り値: { other: 反対向きの行があったか, units: [[pc, pc, ...], ...] }
   *   pc = { pcId, host, start, end, rows: { [kind]: { [streamKey]: samples[] } } }
   */
  function groupByConnection(rows, dir, streamKey) {
    const pcs = new Map();
    let other = false;
    for (const { meta, s } of rows) {
      if (meta.dir !== dir) {
        other = true;
        continue;
      }
      if (meta.kind !== 'video' && meta.kind !== 'audio') continue;
      const k = `${meta.host}|${meta.pcId}`;
      let g = pcs.get(k);
      if (!g) pcs.set(k, (g = { pcId: meta.pcId, host: meta.host, start: s.t, end: s.t, rows: { video: {}, audio: {} } }));
      const sk = streamKey(meta, s);
      (g.rows[meta.kind][sk] ||= []).push({ ...s, pc: meta.pcId, rid: meta.rid || '' });
      if (s.t < g.start) g.start = s.t;
      if (s.t > g.end) g.end = s.t;
    }
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
    return { other, units: units.map((u) => u.pcs) };
  }

  /** 接続の切断（connected から外れた区間）と経路の切り替えを出来事にする */
  function connectionEvents(base) {
    const events = [];
    let down = null, prevRoute = null, prevPairs = null, prevPc = null;
    for (const s of base) {
      if (s.pc !== prevPc) {
        down = null;
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
    return events;
  }

  /** 再接続（PeerConnection のつなぎ目）を出来事にする */
  function reconnectEvents(pcs) {
    const out = [];
    for (let i = 1; i < pcs.length; i++) {
      out.push({ t: pcs[i].start, kind: 'reconnect', gap: (pcs[i].start - pcs[i - 1].end) / 1000, from: pcs[i - 1].pcId, to: pcs[i].pcId });
    }
    return out;
  }

  /** 接続経路ごとの時間 */
  function routeShare(base, startT) {
    const routes = new Map();
    for (const s of base) if (s.route && s.t >= startT) routes.set(s.route, (routes.get(s.route) || 0) + s._dt);
    const total = [...routes.values()].reduce((a, v) => a + v, 0);
    const relay = [...routes].filter(([r]) => /relay/.test(r)).reduce((a, [, v]) => a + v, 0);
    return {
      routes: [...routes].map(([route, sec]) => ({ route, sec })).sort((a, b) => b.sec - a.sec),
      relayRatio: total ? relay / total : null,
    };
  }

  // ------------------------------------------------------------ 章の枠組み

  function cover({ title, sessions, scope, author, worst, multi, showBadge }) {
    const start = Math.min(...sessions.map((x) => x.start));
    const end = Math.max(...sessions.map((x) => x.end));
    return `
      <header class="cover">
        <h1>${esc(title)}</h1>
        <dl class="meta">
          <div><dt>計測期間</dt><dd>${esc(stamp(start))} 〜 ${esc(stamp(end))}</dd></div>
          <div><dt>対象</dt><dd>${esc([...new Set(sessions.map((x) => x.host))].join(', '))}</dd></div>
          <div><dt>評価範囲</dt><dd>${esc(scope)}</dd></div>
          ${author ? `<div><dt>作成</dt><dd>${esc(author)}</dd></div>` : ''}
          <div><dt>出力日時</dt><dd>${esc(stamp(Date.now()))}</dd></div>
        </dl>
        ${worst != null && showBadge ? verdictBadge(worst, multi ? '全体の判定' : '総合判定') : ''}
      </header>`;
  }

  function verdictBadge(lv, label) {
    const v = VERDICT[lv];
    return `<div class="verdict ${v.key}"><span class="vl">${esc(label)}</span><span class="vv">${v.label}</span></div>`;
  }

  function verdictTag(lv) {
    return `<span class="tag ${VERDICT[lv].key}">${VERDICT[lv].label}</span>`;
  }

  /** 総合判定と所見 */
  function summarySection({ verdict, lead, findings, notes, withBadge }) {
    return `
      <section class="summary">
        <h2>総合判定と所見</h2>
        ${withBadge ? verdictBadge(verdict, '判定') : ''}
        <p class="lead">${esc(lead)}</p>
        ${
          findings.length
            ? `<ul class="findings">${findings
                .map((f) => `<li class="${VERDICT[f.lv].key}">${verdictTag(f.lv)}${esc(f.text)}</li>`)
                .join('')}</ul>`
            : ''
        }
        ${notes.length ? `<p class="note">${esc(notes.join(''))}</p>` : ''}
      </section>`;
  }

  /** 総合判定の導入文。label は「受信」「送信」 */
  function leadText(verdict, label, sec, nCrit, nWarn) {
    if (verdict === LV.crit) return `計測期間（${label} ${dur(sec)}）のうち、${nCrit} 項目で重大値を超えており、視聴品質に影響が出ていました。`;
    if (verdict === LV.warn) return `${label} ${dur(sec)} を通じて概ね継続しましたが、${nWarn} 項目で警告値を超えました。`;
    return `${label} ${dur(sec)} を通じて、設定したしきい値を超える項目はなく、安定した${label}品質でした。`;
  }

  /** 主要指標。cards: [label, value, sub, level] */
  function kpiSection(cards) {
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

  /** しきい値判定の表の1行（連続値） */
  function contRow(m, c, t) {
    if (!c.n) return [m.label, '—', limits(t, m.unit), '—', 'データなし', null];
    return [
      m.label,
      `${fix(c.rep, m.digits)} ${m.unit}（${c.below ? '下位' : '上位'}5%）`,
      limits(t, m.unit),
      `警告 ${pct(c.warnRatio)} / 重大 ${pct(c.critRatio)}`,
      `最小 ${fix(c.min, m.digits)} / 中央 ${fix(c.median, m.digits)} / 最大 ${fix(c.max, m.digits)}`,
      c.level,
    ];
  }

  /** しきい値判定の表。rows: [指標, 判定に使った値, しきい値, 超過時間の割合, 分布, 判定] */
  function judgementSection(rows) {
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
              <td>${lv == null ? '—' : verdictTag(lv)}</td>
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

  /** 判定基準の表。rows: [指標, しきい値, 単位, 比べる値] */
  function criteriaSection(intro, rows) {
    return `
      <section class="criteria">
        <h2>判定基準</h2>
        <p class="dim">${esc(intro)}</p>
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

  const EVENT_LIMIT = 200;

  /** イベント一覧。defs: { kind: [ラベル, タグのクラス] }、detail(e) は内容の文字列 */
  function eventSection(list, defs, detail, emptyText) {
    if (!list.length) return `<section><h2>イベント一覧</h2><p class="dim">${esc(emptyText)}</p></section>`;
    return `
      <section>
        <h2>イベント一覧</h2>
        <table class="grid events">
          <thead><tr><th>時刻</th><th>種類</th><th>内容</th></tr></thead>
          <tbody>
          ${list
            .slice(0, EVENT_LIMIT)
            .map((e) => `<tr><td>${esc(stamp(e.t).slice(11, 19))}</td><td><span class="tag ${defs[e.kind][1]}">${defs[e.kind][0]}</span></td><td>${esc(detail(e))}</td></tr>`)
            .join('')}
          </tbody>
        </table>
        ${list.length > EVENT_LIMIT ? `<p class="dim">ほか ${list.length - EVENT_LIMIT} 件は省略しました。全件は CSV で確認できます。</p>` : ''}
      </section>`;
  }

  /** 再接続・切断・経路変更など、受信と送信で共通の出来事の内容 */
  function commonDetail(e) {
    if (e.kind === 'reconnect') return `途切れ ${fix(e.gap, 1)} 秒（${e.from} → ${e.to}）`;
    if (e.kind === 'disconnect') return `${e.state}${e.sec != null ? `　${fix(e.sec, 1)} 秒で復帰` : '　復帰せず'}`;
    return `${e.from || '—'} → ${e.to || '—'}`;
  }

  /** 内訳の表（解像度・レイヤーなど）。rows: [[ラベル..., 秒]]、heads は見出し */
  function shareTable(heads, rows) {
    if (!rows.length) return '';
    const total = rows.reduce((a, r) => a + r[r.length - 1], 0) || 1;
    return `<table class="grid">
          <thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
          ${rows
            .map((r) => {
              const sec = r[r.length - 1];
              return `<tr>${r
                .slice(0, -1)
                .map((c) => `<td>${esc(c)}</td>`)
                .join('')}<td><span class="bar"><span style="width:${(sec / total) * 100}%"></span></span> ${pct(sec / total)}</td></tr>`;
            })
            .join('')}
          </tbody>
        </table>`;
  }

  /** 素の表。rows の各セルは文字列（エスケープはここで行う） */
  function table(heads, rows) {
    if (!rows.length) return '';
    return `<table class="grid">
          <thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>`;
  }

  function kvSection(title, pairs, extra = '') {
    return `
      <section>
        <h2>${esc(title)}</h2>
        <dl class="kv2">
          ${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        ${extra}
      </section>`;
  }

  // ------------------------------------------------------------ グラフ

  /** 時系列の章。legend は凡例の追加分（HTML） */
  function chartsSection(p, list, legend) {
    if (!list.length) return '';
    return `
      <section class="charts">
        <h2>時系列</h2>
        <p class="legend"><span class="lg crit"></span>重大値 <span class="lg warn"></span>警告値 ${legend}</p>
        ${list.map((ch) => chart(p, ch)).join('')}
      </section>`;
  }

  /**
   * 1枚の折れ線。全グラフで時間軸を揃え、区間（bands）と時点（marks）を重ねて描く。
   * ch = { title, series: [{ pts: [{t, v, pc}], cls, name?, scale? }], th?, cap?, bands?, marks? }
   */
  function chart(p, ch) {
    const W = 700, H = 130, L = 44, R = 8, T = 8, B = 20;
    const t0 = p.start, t1 = Math.max(p.end, p.start + 1);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);

    const lines = ch.series.map((s) => {
      // 値なし・記録の欠け・PeerConnection の切り替わりで線を切る
      const pts = [];
      s.pts.forEach((q, i) => {
        const prev = s.pts[i - 1];
        if (prev && (prev.pc !== q.pc || q.t - prev.t > p.step * 3)) pts.push(null);
        if (q.v == null) return pts.push(null);
        let v = q.v * (s.scale || 1);
        if (ch.cap) v = Math.min(v, ch.cap);
        pts.push([q.t, v]);
      });
      return { ...s, line: thin(pts, W - L - R) };
    });
    const vals = lines.flatMap((l) => l.line.filter(Boolean).map((q) => q[1]));
    const names = lines.filter((l) => l.name);
    const caption = `${esc(ch.title)}${names.map((l) => ` <span class="key ${l.cls}"></span>${esc(l.name)}`).join('')}`;
    if (!vals.length) return `<figure class="chart"><figcaption>${caption}</figcaption><p class="dim">データなし</p></figure>`;

    let ymax = Math.max(...vals);
    if (ch.th) for (const k of ['warn', 'crit']) if (ch.th[k] != null && (!ch.cap || ch.th[k] <= ch.cap)) ymax = Math.max(ymax, ch.th[k]);
    ymax = nice(ymax || 1);
    const y = (v) => T + (1 - v / ymax) * (H - T - B);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="plot" role="img" aria-label="${esc(ch.title)}">`;
    for (const v of [0, ymax / 2, ymax]) {
      svg += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="ax" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmtAxis(v)}</text>`;
    }
    for (let k = 0; k <= 4; k++) {
      const t = t0 + ((t1 - t0) * k) / 4;
      svg += `<text class="ax" x="${x(t)}" y="${H - 5}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${esc(stamp(t).slice(11, 19))}</text>`;
    }
    for (const b of ch.bands || []) {
      const xa = x(b.t), xb = Math.max(x(b.end || b.t), xa + 1.5);
      svg += `<rect class="band" x="${xa}" y="${T}" width="${xb - xa}" height="${H - T - B}"/>`;
    }
    for (const t of ch.marks || []) svg += `<line class="err" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/>`;
    if (ch.th) {
      for (const k of ['warn', 'crit']) {
        const v = ch.th[k];
        if (v == null || v > ymax) continue;
        svg += `<line class="th ${k}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      }
    }
    for (const l of lines) {
      let d = '', pen = false;
      for (const q of l.line) {
        if (!q) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`;
        pen = true;
      }
      svg += `<path class="ln ${l.cls}" d="${d}"/>`;
    }
    svg += `<line class="axl" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/></svg>`;

    return `
      <figure class="chart">
        <figcaption>${caption}</figcaption>
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

  // ------------------------------------------------------------ 整形

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

  globalThis.WRA_REPORT = {
    LV,
    VERDICT,
    num,
    median,
    quantile,
    weigh,
    weightedMean,
    contStats,
    seriesStats,
    levelOf,
    groupByConnection,
    connectionEvents,
    reconnectEvents,
    routeShare,
    cover,
    verdictBadge,
    verdictTag,
    summarySection,
    leadText,
    kpiSection,
    contRow,
    judgementSection,
    limits,
    criteriaSection,
    eventSection,
    commonDetail,
    shareTable,
    table,
    kvSection,
    chartsSection,
    chart,
    lvName,
    lvKey,
    fix,
    pct,
    bps,
    dur,
    stamp,
    version,
    esc,
  };
})();

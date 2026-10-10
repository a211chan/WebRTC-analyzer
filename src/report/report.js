/*
 * WebRTC Analyzer — 品質レポートの入口
 *
 * 保存済みの履歴（wra:s: / wra:c:）から印刷用のHTMLを組み立てる。
 * PDF化はブラウザの印刷（「PDFに保存」）に任せるので、ライブラリもフォントも同梱しない。
 *
 * URL: report.html?dir=in|out&s=<sessionId>,<sessionId>...
 *   dir=in  受信品質レポート（report-recv.js）。省略時はこちら
 *   dir=out 送信品質レポート（report-send.js）
 *   セッションが複数あれば1冊にまとめる（冒頭に比較表）。分けるかどうかは設定画面が決め、
 *   分けるときはセッションごとにこのページを開く。
 *
 * 受信と送信は別々に評価する。両者を突き合わせた統合レポートはこの拡張の範囲外。
 * 判定は設定画面のしきい値（cfg.thresholds）だけを使う。レポート専用の基準は持たない。
 * 総合判定は、重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外は「良好」。
 */
(() => {
  'use strict';

  const R = WRA_REPORT;
  const { merge, KEYS } = WRA_CONFIG;
  const { listSessions, loadRows, fileStamp } = WRA_EXPORT;
  const { esc, stamp, verdictTag } = R;

  const $ = (id) => document.getElementById(id);

  (async () => {
    $('print').addEventListener('click', () => window.print());
    const root = $('report');
    try {
      const params = new URLSearchParams(location.search);
      const K = WRA_REPORT_KINDS[params.get('dir') === 'out' ? 'out' : 'in'];
      const cfg = merge(await chrome.storage.local.get(KEYS));
      const ids = (params.get('s') || '').split(',').filter(Boolean);
      const all = await listSessions();
      const picked = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean).sort((a, b) => a.start - b.start);
      if (!picked.length) {
        root.innerHTML = '<p class="loading">対象のセッションが見つかりません。保存期間を過ぎて削除された可能性があります。</p>';
        return;
      }

      const sessions = [];
      for (const s of picked) sessions.push({ session: s, ...K.analyzeSession(await loadRows(s), cfg) });

      root.innerHTML = render(K, sessions, cfg);
      // 「PDFに保存」の既定のファイル名になる
      document.title = `${K.filePrefix}-${fileStamp(picked[0].start)}${picked.length > 1 ? `-${picked.length}` : ''}`;
    } catch (e) {
      root.innerHTML = `<p class="loading">レポートを作れませんでした: ${esc(e && e.message)}</p>`;
    }
  })();

  function render(K, sessions, cfg) {
    const r = cfg.report;
    const sec = r.sections;
    const S = K.sections;
    const other = sessions.some((x) => x.other);
    const items = sessions.flatMap(({ session, other, items }) => items.map((p) => ({ session, other, p }))).filter((x) => x.p.n);
    const footer = `<footer class="foot">WebRTC Analyzer ${esc(R.version())} で作成。${esc(K.footer)}</footer>`;
    const title = K.title(cfg);

    if (!items.length) {
      return (
        R.cover({ title, sessions: sessions.map((x) => x.session), scope: K.scope(other), author: r.author }) +
        `<section><p class="lead">${esc(K.empty(other))}</p></section>` +
        footer
      );
    }

    const worst = Math.max(...items.map((x) => x.p.verdict));
    const multi = items.length > 1;
    let html = R.cover({
      title,
      sessions: items.map((x) => ({ host: x.session.host, start: x.p.start, end: x.p.end })),
      scope: K.scope(other),
      author: r.author,
      worst,
      multi,
      showBadge: sec.summary,
    });
    if (multi) html += compareTable(K, items);

    items.forEach(({ session, other, p }, i) => {
      html += `<article class="${multi ? 'player paged' : 'player'}">`;
      if (multi) html += `<h2 class="ptitle">${esc(`${i + 1}. ${session.host}　${stamp(p.start)} 〜 ${stamp(p.end).slice(11)}（${p.pcs.join(' → ')}）`)}</h2>`;
      if (sec.summary) html += S.summary(p, cfg, multi);
      if (sec.kpi) html += S.kpi(p);
      if (sec.judgement) html += S.judgement(p, cfg);
      if (sec.charts) html += S.charts(p, cfg);
      if (sec.events) html += S.events(p);
      if (sec.stream) html += S.stream(p);
      if (sec.conditions) html += S.conditions(p, session, other);
      html += '</article>';
    });

    if (sec.criteria) html += S.criteria(cfg);
    return html + footer;
  }

  function compareTable(K, items) {
    return `
      <section>
        <h2>セッション一覧</h2>
        <table class="grid">
          <thead><tr><th>#</th><th>開始</th><th>対象</th>${K.compare.heads.map((h) => `<th>${esc(h)}</th>`).join('')}<th>判定</th></tr></thead>
          <tbody>
          ${items
            .map(
              ({ session, p }, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${esc(stamp(p.start))}</td>
              <td>${esc(session.host)}</td>
              ${K.compare.cells(p).map((c) => `<td>${esc(c)}</td>`).join('')}
              <td>${verdictTag(p.verdict)}</td>
            </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </section>`;
  }
})();

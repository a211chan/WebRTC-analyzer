/*
 * WebRTC Analyzer — エクスポートと履歴の永続化
 *
 * 小窓（overlay.js）と設定画面の両方から使う。
 *   - CSV / JSON の組み立て
 *   - chrome.storage.local に書き出した履歴の読み書き
 *
 * 保存形式（キーはすべて "wra:" で始まる。設定のキーとは衝突しない）
 *   wra:s:<sid>      セッションの概要 { id, host, start, end, rows, chunks }
 *   wra:c:<sid>:<n>  n 番目の書き出し分 { metas: {k: meta}, rows: [[k, sample], ...] }
 *
 * 書き出しのたびに概要と新しいチャンクを足すだけで、既存のキーは読み直さない。
 * 1ページ = 1セッションで、キーはタブごとに分かれるので、タブ間の競合も起きない。
 */
(() => {
  if (globalThis.WRA_EXPORT) return;

  const SESSION = 'wra:s:';
  const CHUNK = 'wra:c:';

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
    ['freeze_duration_ms', (m, s) => round(s.freezeMs, 0)],
    ['nack_count', (m, s) => s.nack],
    ['retransmitted_packets', (m, s) => s.rtx],
    ['pli_count', (m, s) => s.pli],
    ['frames_dropped', (m, s) => s.dropped],
    ['rtt_ms', (m, s) => round(s.rttMs, 2)],
    ['quality_limitation', (m, s) => s.limit],
    ['avail_out_bps', (m, s) => round(s.availOutBps, 0)],
    ['avail_in_bps', (m, s) => round(s.availInBps, 0)],
    ['route', (m, s) => s.route],
    ['state', (m, s) => s.state],
  ];

  /** rows: [{ meta, s }] を時刻順に並べ済みで受け取り、{ text, mime } を返す */
  function build(kind, rows) {
    if (kind === 'csv') {
      const lines = [COLS.map((c) => c[0]).join(',')];
      for (const { meta, s } of rows) lines.push(COLS.map((c) => csvCell(c[1](meta, s))).join(','));
      // BOM(U+FEFF) + CRLF。Excel で開いたときに文字化けせず、行も崩れない。
      return { text: '﻿' + lines.join('\r\n'), mime: 'text/csv;charset=utf-8' };
    }
    const out = rows.map(({ meta, s }) => Object.fromEntries(COLS.map((c) => [c[0], c[1](meta, s) ?? null])));
    return { text: JSON.stringify(out, null, 1), mime: 'application/json' };
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

  function filename(kind, t = Date.now()) {
    const d = new Date(t);
    return `webrtc-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${kind}`;
  }

  // ------------------------------------------------------------ 永続化

  function newSessionId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 1回ぶんの書き出し。概要とチャンクを同時に set する */
  function writeChunk(session, metas, rows) {
    const n = session.chunks++;
    session.rows += rows.length;
    session.end = Date.now();
    return chrome.storage.local.set({
      [SESSION + session.id]: { ...session },
      [CHUNK + session.id + ':' + n]: { metas, rows },
    });
  }

  async function allKeys() {
    if (chrome.storage.local.getKeys) return chrome.storage.local.getKeys();
    return Object.keys(await chrome.storage.local.get(null));
  }

  /** 保存済みセッションの概要一覧（新しい順） */
  async function listSessions() {
    const keys = (await allKeys()).filter((k) => k.startsWith(SESSION));
    if (!keys.length) return [];
    const got = await chrome.storage.local.get(keys);
    return Object.values(got)
      .filter((v) => v && typeof v.id === 'string')
      .sort((a, b) => b.start - a.start);
  }

  /** セッションの全サンプルを { meta, s } の時刻順で返す */
  async function loadRows(session) {
    const keys = [];
    for (let i = 0; i < session.chunks; i++) keys.push(CHUNK + session.id + ':' + i);
    const got = await chrome.storage.local.get(keys);
    const rows = [];
    for (const k of keys) {
      const c = got[k];
      if (!c || !Array.isArray(c.rows)) continue;
      for (const [mk, s] of c.rows) if (c.metas[mk]) rows.push({ meta: c.metas[mk], s });
    }
    rows.sort((a, b) => a.s.t - b.s.t);
    return rows;
  }

  async function removeSessions(sessions) {
    const keys = [];
    for (const s of sessions) {
      keys.push(SESSION + s.id);
      for (let i = 0; i < s.chunks; i++) keys.push(CHUNK + s.id + ':' + i);
    }
    // 概要を書き損ねたチャンクが残らないよう、同じ接頭辞のキーも拾って消す
    const ids = new Set(sessions.map((s) => s.id));
    for (const k of await allKeys()) {
      if (k.startsWith(CHUNK) && ids.has(k.slice(CHUNK.length).split(':')[0])) keys.push(k);
    }
    if (keys.length) await chrome.storage.local.remove([...new Set(keys)]);
  }

  /** 最後の書き込みから hours 時間を過ぎたセッションを消す */
  async function prune(hours) {
    const cutoff = Date.now() - hours * 3600000;
    const old = (await listSessions()).filter((s) => s.end < cutoff);
    if (old.length) await removeSessions(old);
  }

  // ------------------------------------------------------------ 整形

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

  globalThis.WRA_EXPORT = {
    build,
    dataUrl,
    filename,
    localStamp,
    newSessionId,
    writeChunk,
    listSessions,
    loadRows,
    removeSessions,
    prune,
  };
})();

/*
 * WebRTC Analyzer — 中継層（ISOLATED world / 全フレーム / document_start）
 *
 * 双方向の橋渡しをする。
 *   上り: MAIN world の patch.js が postMessage したメトリクス → Service Worker
 *   下り: chrome.storage の設定（ポーリング間隔）→ MAIN world の patch.js
 *
 * MAIN world から window.top.postMessage で直接親へ送る手もあるが、
 * クロスオリジンだと targetOrigin: '*' が必要になりメトリクスがページ側の
 * スクリプトから読めてしまう。SW を経由すれば拡張の世界の中で完結する。
 */
(() => {
  'use strict';

  const CHANNEL = 'webrtc-analyzer';

  window.addEventListener('message', (event) => {
    // 出所の検証。ページ側の任意のスクリプトが偽メトリクスを送れるため必須。
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__wraChannel !== CHANNEL) return;

    // patch.js が先に立ち上がっていた場合の設定要求
    if (data.type === 'hello') {
      pushConfig();
      return;
    }

    if (data.type !== 'stats' || !Array.isArray(data.pcs)) return;

    // patch.js の出力だけを信用することはできない。同じ world にページ本体の
    // スクリプトが同居しており、event.source === window は偽装できてしまう。
    // ここで形を作り直し、以降の層には既知の形しか流さない。
    const pcs = sanitize(data.pcs);
    if (!pcs.length) return;

    try {
      chrome.runtime.sendMessage({
        __wraChannel: CHANNEL,
        type: 'stats',
        pcs,
        // 複数フレームのPCを区別するためのラベル。about:blank / blob: では host が空になる
        host: (location.host || location.protocol || 'frame').slice(0, MAX_STR),
      });
    } catch (_) {
      // 拡張の再読み込み直後は context が無効化されている。次の tick で復帰する。
    }
  });

  // --------------------------------------------------------------- 検証

  /*
   * ページ側は同じ world から偽のメトリクスを postMessage できる。素通しすると、
   *   - inbound / outbound が配列でないと描画層の spread が投げ、小窓が止まる
   *   - pc.id を毎回変えられると描画層の Map が無制限に増える
   *   - 長大な文字列を小窓に出せる
   * の3つが成立する。信用するのではなく、既知のフィールドだけを写し取って作り直す。
   */

  const MAX_PCS = 8;
  const MAX_STREAMS = 8;
  const MAX_STR = 64;

  function str(v, max = MAX_STR) {
    return typeof v === 'string' && v ? v.slice(0, max) : null;
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function sanitize(pcs) {
    return pcs.slice(0, MAX_PCS).map(pcRow).filter(Boolean);
  }

  function pcRow(pc) {
    if (!pc || typeof pc !== 'object') return null;
    const id = str(pc.id, 32);
    if (!id) return null;

    return {
      id,
      state: str(pc.state, 32) || 'unknown',
      ice: str(pc.ice, 32),
      route: str(pc.route, 64),
      protocol: str(pc.protocol, 16),
      rttMs: num(pc.rttMs),
      availOutBps: num(pc.availOutBps),
      availInBps: num(pc.availInBps),
      // 描画層は必ず配列として spread する。ここで配列であることを保証する。
      inbound: streamRows(pc.inbound, 'in'),
      outbound: streamRows(pc.outbound, 'out'),
    };
  }

  function streamRows(list, dir) {
    if (!Array.isArray(list)) return [];
    return list
      .slice(0, MAX_STREAMS)
      .map((s) => streamRow(s, dir))
      .filter(Boolean);
  }

  function streamRow(s, dir) {
    if (!s || typeof s !== 'object') return null;
    return {
      dir,
      kind: str(s.kind, 16) || '?',
      rid: str(s.rid, 32),
      w: num(s.w),
      h: num(s.h),
      srcW: num(s.srcW),
      srcH: num(s.srcH),
      fps: num(s.fps),
      bps: num(s.bps),
      targetBps: num(s.targetBps),
      jitterMs: num(s.jitterMs),
      jbMs: num(s.jbMs),
      lossPct: num(s.lossPct),
      freezes: num(s.freezes),
      rttMs: num(s.rttMs),
      limit: str(s.limit, 32),
      codec: str(s.codec, 64),
    };
  }

  /** MAIN world はストレージを読めないので、こちらから送り込む */
  function pushConfig() {
    chrome.storage.local
      .get('intervalMs')
      .then(({ intervalMs }) => {
        window.postMessage(
          { __wraChannel: CHANNEL, type: 'config', intervalMs: intervalMs ?? 1000 },
          '*'
        );
      })
      .catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.intervalMs) pushConfig();
  });

  // bridge が先に立ち上がっていた場合に備えて、こちらからも一度送る
  pushConfig();
})();

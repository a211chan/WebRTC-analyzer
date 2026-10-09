/*
 * WebRTC Analyzer — 設定の単一の出どころ
 *
 * コンテンツスクリプト（bridge / overlay）と設定画面の両方から読む。
 * コンテンツスクリプトは ES Modules を使えないので globalThis 経由で渡す。
 * 同一フレームに2回注入されうる（bridge 用と overlay 用のエントリ）ため、
 * 先頭でガードして二重定義を避ける。
 */
(() => {
  if (globalThis.WRA_CONFIG) return;

  const DEFAULTS = {
    /** 小窓の表示ON/OFF。ツールバーのアイコンと設定画面のボタンが切り替える */
    enabled: false,
    /** ブラウザ起動時・インストール時に自動で表示ONにするか。OFFなら起動のたびにOFFへ戻す */
    autoStart: false,
    /** getStats() のポーリング間隔(ms)。patch.js へ postMessage で伝える */
    intervalMs: 1000,
    /** スパークライン（折れ線）を出すか */
    sparkline: true,
    /** スパークラインが遡る秒数 */
    sparkSeconds: 60,
    /** エクスポート用に履歴を保持する分数 */
    historyMinutes: 30,
    /** 履歴を chrome.storage.local に書き出し、ページを離れても残すか */
    persist: true,
    /** 書き出した履歴を残す時間。最後の書き込みからこれだけ経つと消す */
    persistHours: 24,
    /** しきい値による色分けを行うか */
    alerts: true,

    /** 表示項目。false にすると小窓から消える */
    fields: {
      route: true,
      avail: true,
      codec: true,
      resolution: true,
      fps: true,
      bitrate: true,
      target: true,
      jitter: true,
      buffer: true,
      loss: true,
      freeze: true,
      rtt: true,
      limit: true,
      src: true,
      // 再送・フリーズの切り分け用。小窓が縦に伸びるので既定では出さない
      nack: false,
      pli: false,
      rtx: false,
      dropped: false,
      freezeDur: false,
    },

    /*
     * しきい値。値がこれ以上になると warn / crit で色が変わる。
     *
     * buffer と rtt は WebRTC CDN 経由の実測に合わせてある。平常時の
     * ジッターバッファが 250〜300ms あるスタックでは 300ms を warn にすると
     * 常時警告になって役に立たない。逆に RTT は平常 50〜60ms なので、
     * 上昇の兆候を掴むには 150ms では遅すぎる。
     */
    thresholds: {
      jitterMs: { warn: 30, crit: 50 },
      bufferMs: { warn: 450, crit: 700 },
      lossPct: { warn: 0.5, crit: 2 },
      rttMs: { warn: 100, crit: 200 },
      /** 直近1サンプルでのフリーズ増分 */
      freeze: { warn: 1, crit: 3 },
    },
  };

  const KEYS = Object.keys(DEFAULTS);

  /** 保存済みの値を既定値に重ねる。入れ子（fields / thresholds）は項目単位でマージする */
  function merge(stored) {
    const out = structuredClone(DEFAULTS);
    if (!stored) return out;

    for (const k of KEYS) {
      if (k === 'fields' || k === 'thresholds') continue;
      if (stored[k] != null) out[k] = stored[k];
    }
    if (stored.fields) {
      for (const [k, v] of Object.entries(stored.fields)) {
        if (k in out.fields) out.fields[k] = v === true;
      }
    }
    if (stored.thresholds) {
      for (const [k, v] of Object.entries(stored.thresholds)) {
        if (out.thresholds[k] && v) Object.assign(out.thresholds[k], v);
      }
    }
    return out;
  }

  async function load() {
    try {
      return merge(await chrome.storage.local.get(KEYS));
    } catch (_) {
      return structuredClone(DEFAULTS);
    }
  }

  globalThis.WRA_CONFIG = { DEFAULTS, KEYS, merge, load };
})();

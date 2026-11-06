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
    /** 表示を ON にしたときの表示先。'hud' = ページ内の小窓 / 'window' = ログウィンドウ */
    display: 'hud',
    /** 小窓・ログウィンドウの表示倍率(%) */
    scale: 100,
    /*
     * 別ウィンドウ（小窓の ⧉）。
     *   mode 'window' : 拡張のページを chrome.windows で開く。ディスプレイと位置を指定できる
     *   mode 'pip'    : Document Picture-in-Picture。常に最前面だが位置は指定できない
     * display: 'window' で ON にしたときは、PiP がユーザー操作なしでは開けないため常に 'window' で開く。
     */
    logWindow: {
      mode: 'window',
      /** chrome.system.display の id。空なら小窓を開いたブラウザウィンドウと同じディスプレイ */
      displayId: '',
      /** ディスプレイの作業領域内での置き場所 */
      anchor: 'top-right',
      width: 360,
      height: 480,
      /** 手で動かした・広げた位置と大きさを次回に使う（保存先は logwinLast） */
      rememberLast: true,
    },
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
      // 裏タブ／ウィンドウ遮蔽の誤判定（マルチディスプレイ）を見抜くための表示状態
      page: true,
      // 送信品質の制限理由ごとの時間割合と、それによる解像度変更回数
      limShare: true,
      // 再送・フリーズの切り分け用。小窓が縦に伸びるので既定では出さない
      nack: false,
      pli: false,
      rtx: false,
      dropped: false,
      freezeDur: false,
      // 受信音声の補間率。音声の途切れは他の項目に出ないので既定で出す
      conceal: true,
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
      jitterMs: { dir: 'above', warn: 30, crit: 50 },
      bufferMs: { dir: 'above', warn: 450, crit: 700 },
      lossPct: { dir: 'above', warn: 0.5, crit: 2 },
      rttMs: { dir: 'above', warn: 100, crit: 200 },
      /** 直近1サンプルでのフリーズ増分 */
      freeze: { dir: 'above', warn: 1, crit: 3 },
      /*
       * 受信映像のフレームレート。ほかと違い「低いほど悪い」ので dir: 'below'。
       * dir は仕様なので設定画面からは変えられない。15fps で配信している場合は
       * 常に警告になるので、配信側の fps に合わせて下げるか空欄にする。
       */
      fps: { dir: 'below', warn: 20, crit: 10 },
      /** 受信音声の補間率(%)。欠けた音声を推測で埋めたサンプルの割合 */
      concealPct: { dir: 'above', warn: 1, crit: 5 },
      /*
       * 送信映像に CPU・帯域による品質制限がかかっていた時間の割合(%)。
       * 期間全体で1つの値なので送信レポートだけが使う（小窓は limit の理由を色で出す）。
       */
      limitPct: { dir: 'above', warn: 10, crit: 30 },
    },

    /*
     * 受信品質レポート（印刷用HTML → ブラウザの「PDFに保存」）。
     * 判定は上の thresholds をそのまま使う。レポート専用のしきい値は持たない。
     */
    report: {
      /** 表紙に出す題名（受信 / 送信） */
      title: 'WebRTC 受信品質レポート',
      sendTitle: 'WebRTC 送信品質レポート',
      /** 作成者・提出先など。空なら出さない */
      author: '',
      /** 複数セッションを選んだとき: 'combined' = 1冊にまとめる / 'separate' = セッションごとに別タブ */
      mode: 'combined',
      /*
       * 裏タブの間と、戻った直後を判定から外す。ブラウザは裏タブのタイマーや描画を省電力のために
       * 間引くので、ページ内で描いた映像（canvas・エフェクト）の送信 fps が 1fps 前後まで落ちる。
       * 配信経路や端末性能の問題ではないので、既定では判定から外して所見とイベントに残す。
       */
      excludeBackground: true,
      /** 出す章。false にすると章ごと省く */
      sections: {
        summary: true,
        kpi: true,
        judgement: true,
        charts: true,
        events: true,
        stream: true,
        conditions: true,
        criteria: true,
      },
      /** 時系列グラフの種類（受信レポート） */
      charts: {
        bitrate: true,
        fps: true,
        buffer: true,
        loss: true,
        rtt: true,
        conceal: true,
      },
      /** 時系列グラフの種類（送信レポート） */
      sendCharts: {
        bitrate: true,
        fps: true,
        loss: true,
        rtt: true,
      },
    },
  };

  const KEYS = Object.keys(DEFAULTS);

  const ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  const SCALE = { min: 50, max: 200, step: 10 };
  const LOGWIN_SIZE = { minW: 240, maxW: 1600, minH: 200, maxH: 1600 };

  /** 保存済みの値を既定値に重ねる。入れ子（fields / thresholds / report / logWindow）は項目単位でマージする */
  function merge(stored) {
    const out = structuredClone(DEFAULTS);
    if (!stored) return out;

    for (const k of KEYS) {
      if (k === 'fields' || k === 'thresholds' || k === 'report' || k === 'logWindow') continue;
      if (k === 'display' || k === 'scale') continue;
      if (stored[k] != null) out[k] = stored[k];
    }
    if (stored.display === 'hud' || stored.display === 'window') out.display = stored.display;
    if (Number.isFinite(stored.scale)) out.scale = clamp(Math.round(stored.scale), SCALE.min, SCALE.max);
    const w = stored.logWindow;
    if (w && typeof w === 'object') {
      if (w.mode === 'window' || w.mode === 'pip') out.logWindow.mode = w.mode;
      if (typeof w.displayId === 'string') out.logWindow.displayId = w.displayId;
      if (ANCHORS.includes(w.anchor)) out.logWindow.anchor = w.anchor;
      if (Number.isFinite(w.width)) out.logWindow.width = clamp(Math.round(w.width), LOGWIN_SIZE.minW, LOGWIN_SIZE.maxW);
      if (Number.isFinite(w.height)) out.logWindow.height = clamp(Math.round(w.height), LOGWIN_SIZE.minH, LOGWIN_SIZE.maxH);
      if (typeof w.rememberLast === 'boolean') out.logWindow.rememberLast = w.rememberLast;
    }
    if (stored.fields) {
      for (const [k, v] of Object.entries(stored.fields)) {
        if (k in out.fields) out.fields[k] = v === true;
      }
    }
    if (stored.thresholds) {
      for (const [k, v] of Object.entries(stored.thresholds)) {
        if (!out.thresholds[k] || !v) continue;
        // dir は保存値で上書きさせない
        if ('warn' in v) out.thresholds[k].warn = v.warn;
        if ('crit' in v) out.thresholds[k].crit = v.crit;
      }
    }
    const r = stored.report;
    if (r && typeof r === 'object') {
      if (typeof r.title === 'string') out.report.title = r.title;
      if (typeof r.sendTitle === 'string') out.report.sendTitle = r.sendTitle;
      if (typeof r.author === 'string') out.report.author = r.author;
      if (r.mode === 'combined' || r.mode === 'separate') out.report.mode = r.mode;
      if (typeof r.excludeBackground === 'boolean') out.report.excludeBackground = r.excludeBackground;
      for (const g of ['sections', 'charts', 'sendCharts']) {
        if (!r[g]) continue;
        for (const [k, v] of Object.entries(r[g])) {
          if (k in out.report[g]) out.report[g][k] = v === true;
        }
      }
    }
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** ログウィンドウをディスプレイの端から離す距離 */
  const LOGWIN_MARGIN = 16;

  /**
   * ログウィンドウを開く矩形。display は chrome.system.display.getInfo() の1件。
   * Service Worker（実際に開く）と設定画面（配置図）で同じ計算を使う。
   */
  function logwinRect(lw, display) {
    const a = display.workArea;
    const m = LOGWIN_MARGIN;
    const width = Math.max(1, Math.min(lw.width, a.width - m * 2));
    const height = Math.max(1, Math.min(lw.height, a.height - m * 2));
    const right = a.left + a.width - width - m;
    const bottom = a.top + a.height - height - m;
    const [left, top] = {
      'top-left': [a.left + m, a.top + m],
      'top-right': [right, a.top + m],
      'bottom-left': [a.left + m, bottom],
      'bottom-right': [right, bottom],
      center: [a.left + (a.width - width) / 2, a.top + (a.height - height) / 2],
    }[lw.anchor] || [right, a.top + m];
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
  }

  async function load() {
    try {
      return merge(await chrome.storage.local.get(KEYS));
    } catch (_) {
      return structuredClone(DEFAULTS);
    }
  }

  globalThis.WRA_CONFIG = { DEFAULTS, KEYS, ANCHORS, SCALE, LOGWIN_SIZE, merge, load, logwinRect };
})();

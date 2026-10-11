/*
 * WebRTC Analyzer — 収集層（MAIN world / 全フレーム / document_start）
 *
 * ページの RTCPeerConnection を Proxy でラップして全インスタンスを捕捉し、
 * 標準の getStats() を定期ポーリングする。累積カウンタは差分計算まで済ませ、
 * 表示に必要なフィールドだけを window.postMessage で bridge.js へ渡す。
 *
 * chrome://webrtc-internals は WebUI 特権ページで拡張から読めないため、
 * 同じデータ源である getStats() を自前で叩くのがこの拡張の心臓部。
 */
(() => {
  'use strict';

  const CHANNEL = 'webrtc-analyzer';
  /** 監視対象が無くなってからポーリングを止めるまでの猶予 */
  const IDLE_STOP_MS = 3000;

  /*
   * ポーリング間隔は設定画面から変えられる。MAIN world からは chrome.storage を
   * 読めないので、ISOLATED world の bridge.js が postMessage で送り込んでくる。
   * 到着前は既定値で回しておく。
   */
  let intervalMs = 1000;

  // 同一フレームで二重に走らせない（拡張の再読み込み時など）
  if (window.__WRA_PATCHED__) return;

  const Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (typeof Native !== 'function') return;

  window.__WRA_PATCHED__ = true;

  let seq = 0;
  let timer = null;
  let idleSince = 0;

  /** @type {Map<RTCPeerConnection, {id: string, prev: Map<string, object>}>} */
  const conns = new Map();

  function register(pc) {
    conns.set(pc, { id: 'pc' + ++seq, prev: new Map() });
    if (!timer) timer = setInterval(tick, intervalMs);
  }

  // bridge.js から設定を受け取る。世界をまたぐので postMessage（構造化クローン）を使う。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__wraChannel !== CHANNEL || d.type !== 'config') return;

    const v = Number(d.intervalMs);
    // 下限を設けないとページを巻き込んで重くなる
    if (!Number.isFinite(v) || v < 200 || v === intervalMs) return;
    intervalMs = v;
    if (timer) {
      clearInterval(timer);
      timer = setInterval(tick, intervalMs);
    }
  });

  // bridge.js より先に読み込まれた場合に備えて、こちらからも設定を要求する
  window.postMessage({ __wraChannel: CHANNEL, type: 'hello' }, '*');

  /*
   * Proxy の construct トラップを使う理由:
   * RTCPeerConnection は ES class なので、関数を自前定義して prototype を代入する
   * 古い手法では new.target 周りで壊れる。Proxy ならプロトタイプチェーン・
   * instanceof・静的メソッド（generateCertificate）が全て素通りする。
   */
  const Wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      try {
        register(pc);
      } catch (_) {
        /* 捕捉に失敗してもページ側の動作は絶対に止めない */
      }
      return pc;
    },
  });

  window.RTCPeerConnection = Wrapped;
  if ('webkitRTCPeerConnection' in window) window.webkitRTCPeerConnection = Wrapped;

  // ---------------------------------------------------------------- polling

  async function tick() {
    const pcs = [];

    for (const pc of [...conns.keys()]) {
      // signalingState は close() 後に必ず 'closed' になる。connectionState は
      // 実装によって遷移しないことがあるので前者で判定する。
      if (pc.signalingState === 'closed') {
        conns.delete(pc);
        continue;
      }
      const st = conns.get(pc);
      let report;
      try {
        report = await pc.getStats();
      } catch (_) {
        continue;
      }
      if (!conns.has(pc)) continue; // await 中に閉じられた
      try {
        pcs.push(summarize(pc, st, report));
      } catch (_) {
        /* 1つのPCの整形失敗で全体を落とさない */
      }
    }

    post(pcs);

    // 監視対象が無くなったらタイマーを止める（非WebRTCページのコストをゼロにする）
    if (conns.size === 0) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > IDLE_STOP_MS) {
        clearInterval(timer);
        timer = null;
        idleSince = 0;
      }
    } else {
      idleSince = 0;
    }
  }

  function post(pcs) {
    // 同一 window 内のリスナ（= ページ本体と拡張の ISOLATED world）にのみ届く。
    // 受信側は e.source === window と __wraChannel の両方を検証すること。
    window.postMessage({ __wraChannel: CHANNEL, type: 'stats', pcs }, '*');
  }

  // -------------------------------------------------------------- summarize

  function summarize(pc, st, report) {
    /** @type {Map<string, any>} */
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));

    const inbound = [];
    const outbound = [];

    for (const s of byId.values()) {
      if (s.type === 'inbound-rtp') inbound.push(inboundRow(s, byId, st));
      else if (s.type === 'outbound-rtp') outbound.push(outboundRow(s, byId, st));
    }

    const conn = connectionRow(byId);

    // 次回の差分計算のために、今回のRTP系レポートだけを保持する
    const next = new Map();
    for (const s of byId.values()) {
      if (s.type === 'inbound-rtp' || s.type === 'outbound-rtp' || s.type === 'remote-inbound-rtp') {
        next.set(s.id, s);
      }
    }
    st.prev = next;

    return {
      id: st.id,
      state: pc.connectionState || pc.iceConnectionState || 'unknown',
      ice: pc.iceConnectionState || null,
      route: conn.route,
      protocol: conn.protocol,
      rttMs: conn.rttMs,
      availOutBps: conn.availOutBps,
      availInBps: conn.availInBps,
      pairChanges: conn.pairChanges,
      inbound: inbound.sort(byKind),
      outbound: outbound.sort(byKind),
    };
  }

  /** video を先に、audio を後に並べる（HUDで見たい順） */
  function byKind(a, b) {
    const rank = (k) => (k === 'video' ? 0 : k === 'audio' ? 1 : 2);
    return rank(a.kind) - rank(b.kind);
  }

  /**
   * 選択中の candidate-pair は transport.selectedCandidatePairId を辿るのが唯一確実。
   * state === 'succeeded' で絞ると複数該当しうる。
   */
  function connectionRow(byId) {
    let transport = null;
    for (const s of byId.values()) {
      if (s.type === 'transport') {
        transport = s;
        break;
      }
    }

    let pair = transport && transport.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : null;
    if (!pair) {
      for (const s of byId.values()) {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          pair = s;
          break;
        }
      }
    }
    // 経路の切り替わり回数（累積）。relay どうしの切り替えは route の文字列では見えない
    const pairChanges = transport && num(transport.selectedCandidatePairChanges) ? transport.selectedCandidatePairChanges : null;
    if (!pair) return { route: null, protocol: null, rttMs: null, availOutBps: null, availInBps: null, pairChanges };

    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const route =
      local || remote ? `${local?.candidateType ?? '?'}→${remote?.candidateType ?? '?'}` : null;

    return {
      route,
      protocol: local?.protocol ?? null,
      rttMs: num(pair.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null,
      availOutBps: num(pair.availableOutgoingBitrate) ? pair.availableOutgoingBitrate : null,
      availInBps: num(pair.availableIncomingBitrate) ? pair.availableIncomingBitrate : null,
      pairChanges,
    };
  }

  function inboundRow(s, byId, st) {
    const d = differ(s, st);

    const dLost = d('packetsLost');
    const dRecv = d('packetsReceived');
    const dJbDelay = d('jitterBufferDelay');
    const dJbCount = d('jitterBufferEmittedCount');
    const dFreezeSec = d('totalFreezesDuration');
    const dPauseSec = d('totalPausesDuration');
    const dDecoded = d('framesDecoded');
    const dDecodeSec = d('totalDecodeTime');
    const dConcealed = d('concealedSamples');
    const dSamples = d('totalSamplesReceived');

    return {
      dir: 'in',
      kind: s.kind || s.mediaType || '?',
      ssrc: num(s.ssrc) ? s.ssrc : null,
      mid: s.mid ?? null,
      w: num(s.frameWidth) ? s.frameWidth : null,
      h: num(s.frameHeight) ? s.frameHeight : null,
      fps: fpsOf(s, d, 'framesDecoded'),
      bps: rate(d('bytesReceived'), d.dt),
      jitterMs: num(s.jitter) ? s.jitter * 1000 : null,
      // 実効遅延。jitter（到着間隔のばらつき）より体感に近い
      jbMs: dJbDelay !== null && dJbCount ? (dJbDelay / dJbCount) * 1000 : null,
      lossPct: dLost !== null && dRecv !== null && dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : null,
      freezes: num(s.freezeCount) ? s.freezeCount : null,
      /*
       * 再送・フリーズ関連。いずれも直近1サンプルでの増分。
       * RTX/NACK で回復したパケットは packetsLost に載らないので、loss 0% のまま
       * フリーズする場合はここを見て「遅延起因か / 供給側か / 描画側か」を切り分ける。
       */
      nack: d('nackCount'),
      pli: d('pliCount'),
      rtx: d('retransmittedPacketsReceived'),
      dropped: d('framesDropped'),
      freezeMs: dFreezeSec !== null ? dFreezeSec * 1000 : null,
      fir: d('firCount'),
      keyFrames: d('keyFramesDecoded'),
      discarded: d('packetsDiscarded'),
      // pause は「5秒以上フレームが来なかった」。freeze より長い途切れ（送信停止・映像OFF）
      pauses: num(s.pauseCount) ? s.pauseCount : null,
      pauseMs: dPauseSec !== null ? dPauseSec * 1000 : null,
      // 1フレームあたりのデコード時間。端末の処理能力不足の切り分け用
      decodeMs: dDecodeSec !== null && dDecoded ? (dDecodeSec / dDecoded) * 1000 : null,
      /*
       * パケット数の増分そのもの。lossPct は1サンプル内の比率なので、期間全体の
       * 損失率をレポートで正しく出すには分子・分母を別に持っておく必要がある。
       */
      pktRecv: dRecv,
      pktLost: dLost,
      /*
       * 音声の補間率。欠けた音声を推測で埋めたサンプルの割合で、映像の freeze に
       * 相当する「聞こえ方の劣化」。loss が 0 でも遅延到着で補間されることがある。
       */
      concealPct: dConcealed !== null && dSamples ? (dConcealed / dSamples) * 100 : null,
      concealEvents: d('concealmentEvents'),
      codec: byId.get(s.codecId)?.mimeType ?? null,
    };
  }

  function outboundRow(s, byId, st) {
    const d = differ(s, st);
    const src = s.mediaSourceId ? byId.get(s.mediaSourceId) : null;

    // 送信側の RTT / ジッター / ロスは相手からの RTCP レポート（remote-inbound-rtp）に載る
    const remote = s.remoteId ? byId.get(s.remoteId) : null;
    const dEncoded = d('framesEncoded');
    const dEncodeSec = d('totalEncodeTime');

    return {
      dir: 'out',
      kind: s.kind || s.mediaType || '?',
      ssrc: num(s.ssrc) ? s.ssrc : null,
      mid: s.mid ?? null,
      rid: s.rid ?? null,
      w: num(s.frameWidth) ? s.frameWidth : null,
      h: num(s.frameHeight) ? s.frameHeight : null,
      // 送信元の解像度。w/h と食い違っていればダウンスケールが効いている
      srcW: src && num(src.width) ? src.width : null,
      srcH: src && num(src.height) ? src.height : null,
      // カメラ（キャプチャ）側の fps。送信 fps と食い違えばエンコーダ側で落としている
      srcFps: src && num(src.framesPerSecond) ? src.framesPerSecond : null,
      // マイクの入力レベル（0〜1）。0 が続けばミュートか無音
      audioLevel: src && num(src.audioLevel) ? src.audioLevel : null,
      fps: fpsOf(s, d, 'framesSent'),
      bps: rate(d('bytesSent'), d.dt),
      // 送信品質が落ちた原因が一発で分かる最重要項目
      limit: s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? s.qualityLimitationReason : null,
      targetBps: num(s.targetBitrate) ? s.targetBitrate : null,
      // 制限がかかっていた時間（直近1サンプルでの増分）。limit は瞬間値なので割合はこちらで出す
      limitCpuMs: limitDelta(s, st, 'cpu'),
      limitBwMs: limitDelta(s, st, 'bandwidth'),
      resChanges: d('qualityLimitationResolutionChanges'),
      // 相手から届いた再送要求・キーフレーム要求と、それに応じた再送。受信側の nack / pli と対になる
      nack: d('nackCount'),
      pli: d('pliCount'),
      fir: d('firCount'),
      rtx: d('retransmittedPacketsSent'),
      keyFrames: d('keyFramesEncoded'),
      encodeMs: dEncodeSec !== null && dEncoded ? (dEncodeSec / dEncoded) * 1000 : null,
      rttMs: remote && num(remote.roundTripTime) ? remote.roundTripTime * 1000 : null,
      jitterMs: remote && num(remote.jitter) ? remote.jitter * 1000 : null,
      lossPct: remote && num(remote.fractionLost) ? remote.fractionLost * 100 : null,
      codec: byId.get(s.codecId)?.mimeType ?? null,
    };
  }

  // ----------------------------------------------------------------- helpers

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /**
   * 前回サンプルとの差分を返すクロージャを作る。
   * Δt はポーリングの揺らぎを受けないよう、レポート自身の timestamp から取る。
   * 再接続やSSRC変更でカウンタがリセットされると差分が負になるので、その場合は破棄。
   */
  function differ(s, st) {
    const p = st.prev.get(s.id);
    const dt = p && num(p.timestamp) && num(s.timestamp) ? (s.timestamp - p.timestamp) / 1000 : 0;
    const fn = (field) => {
      if (!p || !(dt > 0) || !num(s[field]) || !num(p[field])) return null;
      const dv = s[field] - p[field];
      return dv >= 0 ? dv : null;
    };
    fn.dt = dt;
    return fn;
  }

  /** qualityLimitationDurations（理由ごとの累積秒）の増分を ms で返す */
  function limitDelta(s, st, reason) {
    const p = st.prev.get(s.id);
    const a = s.qualityLimitationDurations?.[reason];
    const b = p?.qualityLimitationDurations?.[reason];
    if (!num(a) || !num(b)) return null;
    const dv = a - b;
    return dv >= 0 ? dv * 1000 : null;
  }

  function rate(deltaBytes, dt) {
    return deltaBytes !== null && dt > 0 ? (deltaBytes * 8) / dt : null;
  }

  /** framesPerSecond が来ない実装のために、フレーム数の差分から求め直す */
  function fpsOf(s, d, counterField) {
    if (num(s.framesPerSecond)) return s.framesPerSecond;
    const df = d(counterField);
    return df !== null && d.dt > 0 ? df / d.dt : null;
  }
})();

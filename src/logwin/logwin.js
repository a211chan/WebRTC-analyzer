/*
 * WebRTC Analyzer — ログウィンドウ
 *
 * chrome.windows で開く拡張のページ。小窓と違ってディスプレイと位置を指定できるので、
 * 動画とは別のモニターにメトリクスを出しておける。
 *
 * 計測・履歴・エクスポートは対象タブの overlay.js が持ったまま。ここは overlay.js が
 * 描いた本文の HTML を映すだけで、⤓ などの操作は tabs.sendMessage で overlay.js に頼む。
 * 描画処理を2か所に持たず、履歴も分かれない。
 *
 * どのタブを映すかは Service Worker が決め、storage.session の logwin に置く。
 *   { windowId, tabId, follow }  follow = アクティブなタブを追いかける（ON で開いたとき）
 */
(() => {
  'use strict';

  const CHANNEL = 'webrtc-analyzer';

  let cfg = structuredClone(WRA_CONFIG.DEFAULTS);
  let target = null;
  let host = '';
  let closedTab = false;

  // ------------------------------------------------------------- DOM

  const style = document.createElement('style');
  style.textContent = WRA_STYLE;
  document.head.appendChild(style);

  const hud = document.createElement('div');
  hud.className = 'hud pip';
  hud.innerHTML = `
    <header>
      <span class="title">WebRTC Analyzer</span>
      <span class="alarm" hidden></span>
      <button data-act="zoom-out" title="縮小">⊖</button>
      <button data-act="zoom-in"  title="拡大">⊕</button>
      <button data-act="export"   title="エクスポート">⤓</button>
      <button data-act="options"  title="設定">⚙</button>
      <button data-act="close"    title="閉じてページ内の小窓に戻す">×</button>
    </header>
    <div class="menu" hidden>
      <button data-act="csv">CSV で保存</button>
      <button data-act="json">JSON で保存</button>
      <button data-act="clear">履歴をクリア</button>
      <div class="menu-note"></div>
    </div>
    <div class="body"><div class="empty">接続を待っています…</div></div>`;
  document.body.appendChild(hud);

  const titleEl = hud.querySelector('.title');
  const alarmEl = hud.querySelector('.alarm');
  const menuEl = hud.querySelector('.menu');
  const bodyEl = hud.querySelector('.body');

  hud.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') window.close();
    else if (act === 'options') chrome.runtime.openOptionsPage();
    else if (act === 'export') menuEl.hidden = !menuEl.hidden;
    else if (act === 'zoom-in' || act === 'zoom-out') zoom(act === 'zoom-in' ? 1 : -1);
    else if (act === 'csv' || act === 'json' || act === 'clear') command(act);
  });

  function zoom(dir) {
    const { min, max, step } = WRA_CONFIG.SCALE;
    const next = Math.min(max, Math.max(min, (cfg.scale || 100) + dir * step));
    if (next !== cfg.scale) chrome.storage.local.set({ scale: next });
  }

  function applyScale() {
    const z = (cfg.scale || 100) / 100;
    hud.style.zoom = String(z);
    // ウィンドウいっぱいに広げる高さも zoom で拡大されるので、倍率で割る
    hud.style.minHeight = `${100 / z}vh`;
    bodyEl.style.maxHeight = `calc(${100 / z}vh - 32px)`;
  }

  function paintTitle() {
    const name = host || 'WebRTC Analyzer';
    titleEl.textContent = target?.follow ? `${name} · アクティブなタブ` : name;
    document.title = host ? `${host} — WebRTC Analyzer` : 'WebRTC Analyzer';
  }

  function note(text) {
    const el = menuEl.querySelector('.menu-note');
    el.textContent = text;
    clearTimeout(note.t);
    note.t = setTimeout(() => (el.textContent = ''), 4000);
  }

  // ------------------------------------------------------------- 対象タブ

  async function command(cmd) {
    if (target?.tabId == null || closedTab) {
      note('対象のタブがありません');
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(target.tabId, { __wraChannel: CHANNEL, type: 'logwin-cmd', cmd }, { frameId: 0 });
      if (res?.note) note(res.note);
    } catch (_) {
      note('対象のタブに届きませんでした。ページを再読み込みしてください');
    }
  }

  async function setTarget(next) {
    const changed = next?.tabId !== target?.tabId;
    target = next;
    if (!changed) {
      paintTitle();
      return;
    }
    host = '';
    closedTab = false;
    alarmEl.hidden = true;
    bodyEl.innerHTML = '<div class="empty">接続を待っています…</div>';
    paintTitle();
    // このページが開く前に送られた描画結果は届いていないので、出し直してもらう
    if (target?.tabId != null) command('refresh');
  }

  chrome.storage.session.get('logwin').then((v) => setTarget(v.logwin || null));

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'session' && changes.logwin) setTarget(changes.logwin.newValue || null);
    if (area === 'local' && WRA_CONFIG.KEYS.some((k) => k in changes)) {
      cfg = await WRA_CONFIG.load();
      applyScale();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId !== target?.tabId || target.follow) return;
    // 最後の表示は残し、閉じられたことだけ知らせる
    closedTab = true;
    titleEl.textContent = `${host || 'WebRTC Analyzer'} · 元のタブが閉じられました`;
  });

  // ------------------------------------------------------------- 受信

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.__wraChannel !== CHANNEL || msg.type !== 'mirror') return;
    // 映すのは対象タブのトップフレームだけ（子フレームは描画結果を送らない）
    if (sender.tab?.id !== target?.tabId || sender.frameId !== 0) return;
    if (typeof msg.html !== 'string') return;

    host = typeof msg.host === 'string' ? msg.host : '';
    paintTitle();
    bodyEl.replaceChildren(sanitize(msg.html));
    const alarms = Number.isInteger(msg.alarms) ? msg.alarms : 0;
    alarmEl.hidden = !(cfg.alerts && alarms > 0);
    alarmEl.textContent = alarms > 0 ? `⚠ ${alarms}` : '';
  });

  /*
   * overlay.js が esc() 済みで組み立てた HTML だが、ここは拡張のページ（権限を持つ側）なので
   * 念のため実行されうるものを落とす。MV3 の既定の CSP でインラインスクリプトはもともと動かない。
   */
  const DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'STYLE', 'META', 'BASE', 'FORM', 'IMG', 'A']);
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
    const drop = [];
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (DROP.has(el.tagName.toUpperCase())) {
        drop.push(el);
        continue;
      }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'href' || n === 'xlink:href' || n === 'src' || n === 'srcset') el.removeAttribute(a.name);
      }
    }
    for (const el of drop) el.remove();
    return tpl.content;
  }

  // ------------------------------------------------------------- 起動

  WRA_CONFIG.load().then((c) => {
    cfg = c;
    applyScale();
  });
})();

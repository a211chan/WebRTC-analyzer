/*
 * WebRTC Analyzer — HUD のスタイル
 *
 * コンテンツスクリプトは ES Modules を使えない。manifest の js: [...] に列挙した
 * ファイルは同一スコープを共有するので、グローバル変数で overlay.js へ渡す。
 * Shadow DOM 内に注入されるため、ページ側のCSSとは完全に隔離される。
 */
var WRA_STYLE = `
:host { all: initial; }

.hud {
  position: fixed;
  z-index: 2147483647;
  top: 12px;
  right: 12px;
  min-width: 232px;
  max-width: 340px;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  color: #e8eaed;
  background: rgba(18, 20, 24, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  overflow: hidden;
  user-select: none;
}

/* スパークライン表示時は折れ線1本ぶん横に広げる */
.hud.spark { min-width: 272px; }

/* 別ウィンドウ（Document PiP）内ではウィンドウいっぱいに広げる */
.hud.pip {
  position: static;
  width: 100%;
  max-width: none;
  min-height: 100vh;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: rgb(18, 20, 24);
}
.hud.pip header { cursor: default; }
.hud.pip .body { max-height: calc(100vh - 32px); }

.hud.collapsed .body,
.hud.collapsed .menu { display: none; }

header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: rgba(255, 255, 255, 0.06);
  cursor: move;
  touch-action: none;
}

header .title {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 10px;
  color: #b9bec6;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

header button {
  all: unset;
  cursor: pointer;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  text-align: center;
  line-height: 16px;
  font-size: 12px;
  color: #b9bec6;
}
header button:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }

header .alarm {
  color: #ff9c8a;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

/* display: flex は [hidden] の UA スタイルより強いので、明示的に打ち消す */
.menu[hidden] { display: none; }

.menu {
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  padding: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.menu button {
  all: unset;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 10px;
  color: #cfd4da;
  background: rgba(255, 255, 255, 0.08);
}
.menu button:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
.menu-note { flex-basis: 100%; color: #7fb2ff; font-size: 10px; min-height: 0; }
.menu-note:empty { display: none; }

.body { padding: 6px 8px 8px; max-height: 70vh; overflow-y: auto; }

.pc + .pc { margin-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 7px; }

.pc-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 10px;
  color: #9aa1ab;
}
.pc-head .src { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-head .state { font-weight: 600; }
.state-connected  { color: #6ee7a0; }
.state-connecting { color: #f5c451; }
.state-failed,
.state-disconnected,
.state-closed     { color: #f2857b; }

.stream { margin-top: 4px; }

.stream-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: #cfd4da;
}
.stream-head .arrow { font-weight: 700; color: #7fb2ff; width: 9px; }
.stream-head .arrow.out { color: #ffb37f; }
.stream-head .kind { color: #9aa1ab; width: 36px; }
.stream-head .head-main { font-weight: 600; }
.stream-head .codec { margin-left: auto; color: #757d88; font-size: 10px; }

.kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 8px;
  padding-left: 14px;
}
.kv div { display: flex; gap: 4px; white-space: nowrap; }
.kv .k { color: #838b96; }
.kv .v { color: #e8eaed; margin-left: auto; }

/* スパークラインON: ラベル / 折れ線 / 値 の3列 */
.kvs { padding-left: 14px; }
.kvs > div {
  display: grid;
  grid-template-columns: 52px 84px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.kvs .k { color: #838b96; }
.kvs .v { color: #e8eaed; text-align: right; }
.kvs .sp { height: 13px; line-height: 0; }

.spark { display: block; overflow: visible; }
.spark polyline {
  fill: none;
  stroke: #6f86a8;
  stroke-width: 1;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* しきい値超え */
.v.warn { color: #ffb37f; }
.v.crit { color: #ff8b7d; font-weight: 700; }

.empty { color: #838b96; padding: 2px 0; }
`;

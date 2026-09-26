/*
 * standalone.html 専用の chrome.* エミュレータ。
 * Service Worker の代わりに、bridge.js の sendMessage を同一ページ内の
 * overlay.js の onMessage へ折り返す。sw.js と同じく frameId を付与する。
 *
 * 拡張本体では使わない。テストのためだけのファイル。
 */
(() => {
  const msgListeners = [];
  const changeListeners = [];
  const store = Object.create(null);

  window.chrome = {
    runtime: {
      sendMessage(msg) {
        // sw.js と同じ振る舞い: frameId を付けて折り返す
        const payload = { ...msg, frameId: 0 };
        setTimeout(() => msgListeners.forEach((fn) => fn(payload, { tab: { id: 1 }, frameId: 0 }, () => {})), 0);
        return Promise.resolve();
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
    },
    storage: {
      local: {
        get(keys) {
          const out = {};
          for (const k of keys == null ? Object.keys(store) : [].concat(keys)) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        },
        getKeys() {
          return Promise.resolve(Object.keys(store));
        },
        set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          setTimeout(() => changeListeners.forEach((fn) => fn(changes, 'local')), 0);
          return Promise.resolve();
        },
        remove(keys) {
          const changes = {};
          for (const k of [].concat(keys)) {
            if (!(k in store)) continue;
            // 実 API と同じく newValue を持たせない
            changes[k] = { oldValue: store[k] };
            delete store[k];
          }
          setTimeout(() => changeListeners.forEach((fn) => fn(changes, 'local')), 0);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    downloads: {
      // 設定画面プレビュー用。実際には保存せず、中身をコンソールに出す
      download({ url, filename }) {
        console.log('[shim] download', filename, url.length, 'chars');
        return Promise.resolve(1);
      },
    },
  };
  // 検証用に中身を覗けるようにしておく
  window.__shimStore = store;
})();

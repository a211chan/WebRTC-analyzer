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
        // sw.js の応答が要るものは、ここで代わりに返す
        if (msg?.type === 'download') {
          console.log('[shim] download', msg.filename, msg.url.length, 'bytes (data URL)');
          return Promise.resolve({ ok: true });
        }
        // ログウィンドウ。拡張なしでは開けないので、常に「映していない」と答える
        if (msg?.type === 'logwin-get') return Promise.resolve({ open: false });
        if (msg?.type === 'logwin-open' || msg?.type === 'mirror') return Promise.resolve();

        // sw.js と同じ振る舞い: frameId を付けて折り返す
        const payload = { ...msg, frameId: 0 };
        setTimeout(() => msgListeners.forEach((fn) => fn(payload, { tab: { id: 1 }, frameId: 0 }, () => {})), 0);
        return Promise.resolve();
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      // overlay.js は id が無いと「拡張から切り離された」とみなして描画をやめる
      id: 'shim',
      getManifest: () => ({ version: '1.0.0' }),
      // 設定画面プレビュー用の更新確認。?update=available で新しい版がある体にする
      requestUpdateCheck() {
        if (!location.search.includes('update=available')) return Promise.resolve({ status: 'no_update' });
        // 実物と同じく、ダウンロードが済んでから onUpdateAvailable（sw.js が updatePending を書く）が来る
        setTimeout(() => chrome.storage.local.set({ updatePending: '1.1.0' }), 1500);
        return Promise.resolve({ status: 'update_available', version: '1.1.0' });
      },
      reload: () => console.log('[shim] runtime.reload'),
    },
    // ?install=development で zip 版（バージョン表記だけ）の見え方にする
    management: {
      getSelf: () =>
        Promise.resolve({ installType: (location.search.match(/install=(\w+)/) || [])[1] || 'normal' }),
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
    // 設定画面プレビュー用。デュアルモニター（右にサブディスプレイ）を装う
    system: {
      display: {
        getInfo: () =>
          Promise.resolve([
            { id: '1', name: 'Built-in Display', isPrimary: true, bounds: { left: 0, top: 0, width: 1512, height: 982 }, workArea: { left: 0, top: 25, width: 1512, height: 957 } },
            { id: '2', name: 'DELL U2723QE', isPrimary: false, bounds: { left: 1512, top: -200, width: 2560, height: 1440 }, workArea: { left: 1512, top: -175, width: 2560, height: 1415 } },
          ]),
        onDisplayChanged: { addListener() {} },
      },
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

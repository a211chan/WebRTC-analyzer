/*
 * 同一ページ内で PeerConnection を2つ張り、canvas の映像と発振音を送受信する。
 * カメラ/マイクの許可が要らないので、どの環境でもそのまま動く。
 */
(() => {
  const canvas = document.getElementById('src');
  const ctx = canvas.getContext('2d');
  const log = (m) => (document.getElementById('log').textContent = m);

  let t = 0;
  function draw() {
    t += 0.02;
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, 640, 360);
    for (let i = 0; i < 12; i++) {
      const x = 320 + Math.cos(t + i * 0.5) * 240;
      const y = 180 + Math.sin(t * 1.3 + i * 0.5) * 120;
      ctx.fillStyle = `hsl(${(i * 30 + t * 60) % 360} 70% 60%)`;
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.fill();
    }
    // 動きの少ない映像だとエンコーダがビットレートを絞ってしまうのでノイズ帯を足す
    const img = ctx.createImageData(640, 40);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 320);
  }
  // requestAnimationFrame はタブが前面でないと絞られ、captureStream にフレームが
  // 流れなくなる。検証の再現性を優先して setInterval で回す。
  setInterval(draw, 1000 / 30);
  draw();

  (async () => {
    const stream = canvas.captureStream(30);

    // 音声トラックも足して audio 行の表示を確認する
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    pc2.ontrack = (e) => (document.getElementById('dst').srcObject = e.streams[0]);
    stream.getTracks().forEach((tr) => pc1.addTrack(tr, stream));

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    // DevToolsコンソールから生statsを直接確認できるようにしておく。
    // 例: await __loopback.pc2.getStats().then(r => [...r.values()])
    window.__loopback = { pc1, pc2 };

    const report = () => log(`pc1(送信): ${pc1.connectionState}   pc2(受信): ${pc2.connectionState}`);
    pc1.onconnectionstatechange = report;
    pc2.onconnectionstatechange = report;
    report();
  })().catch((e) => log('失敗: ' + e));

  // #3 の再現用。コンテナではなく <video> 要素そのものを全画面にする素朴なプレーヤーを模す
  document.getElementById('fsVideo')?.addEventListener('click', () => {
    document.getElementById('dst').requestFullscreen();
  });
})();

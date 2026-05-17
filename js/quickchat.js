// ============= クイックチャット & チャットバブル =============
const QuickChat = {
  MESSAGES: {
    nice:   { text: '👍 ナイス！', color: '#4caf50' },
    sorry:  { text: '🙏 ごめん！', color: '#ffa726' },
    ok:     { text: '🤝 おk！', color: '#29b6f6' },
    defend: { text: '🛡 戻る！', color: '#ef5350' },
    taken:  { text: '⚡ おれ行く', color: '#ffeb3b' },
    wow:    { text: '😱 すげぇ！', color: '#ab47bc' },
  },

  init() {
    const btn = document.getElementById('quickchat-btn');
    const menu = document.getElementById('quickchat-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('show');
    });
    menu.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', (e) => {
        const msg = b.dataset.msg;
        this.send(msg);
        menu.classList.remove('show');
      });
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.classList.remove('show');
      }
    });
  },

  send(msgKey) {
    if (!Game.localCar) return;
    this.showBubble(Game.localCar, msgKey);
    // ネット経由でブロードキャスト
    if (Net.peer) {
      if (Net.isHost) Net._broadcast({ type: 'chat', id: Game.myInfo.id, msg: msgKey });
      else Net.sendToHost({ type: 'chat', msg: msgKey });
    }
  },

  showBubble(car, msgKey) {
    const m = this.MESSAGES[msgKey];
    if (!m) return;
    const container = document.getElementById('quickchat-bubbles');
    if (!container) return;
    const b = document.createElement('div');
    b.className = 'chat-bubble';
    b.textContent = m.text;
    b.style.borderColor = m.color;
    b.style.color = m.color;

    // 車のスクリーン座標を毎フレーム追従させたいが、ここでは初期投影位置に置く
    const screen = this._project(car);
    b.style.left = screen.x + 'px';
    b.style.top  = screen.y + 'px';
    container.appendChild(b);
    setTimeout(() => b.remove(), 2500);
  },

  _project(car) {
    if (!Game.camera || !Game.renderer) return { x: 200, y: 100 };
    const v = new THREE.Vector3(car.x, car.y + 5, car.z);
    v.project(Game.camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: (v.x * 0.5 + 0.5) * w,
      y: (-v.y * 0.5 + 0.5) * h,
    };
  },
};

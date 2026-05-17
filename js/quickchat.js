// ============= クイックチャット & チャットバブル =============
// PDCA7 改善:
//   - チャットバブルが車のスクリーン位置を毎フレーム追従する (Game.update から呼び出し)
//   - 同じ車から続けてメッセージ出すと前のバブルが消える
const QuickChat = {
  MESSAGES: {
    nice:   { text: '👍 ナイス！', color: '#4caf50' },
    sorry:  { text: '🙏 ごめん！', color: '#ffa726' },
    ok:     { text: '🤝 おk！', color: '#29b6f6' },
    defend: { text: '🛡 戻る！', color: '#ef5350' },
    taken:  { text: '⚡ おれ行く', color: '#ffeb3b' },
    wow:    { text: '😱 すげぇ！', color: '#ab47bc' },
  },

  _activeBubbles: [], // { el, car, expiresAt }

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

    // 既存のこの車のバブルを除去
    for (let i = this._activeBubbles.length - 1; i >= 0; i--) {
      if (this._activeBubbles[i].car === car) {
        const b = this._activeBubbles[i];
        if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
        this._activeBubbles.splice(i, 1);
      }
    }

    const el = document.createElement('div');
    el.className = 'chat-bubble';
    el.textContent = m.text;
    el.style.borderColor = m.color;
    el.style.color = m.color;
    container.appendChild(el);

    const bubble = { el, car, expiresAt: performance.now() + 2400 };
    this._activeBubbles.push(bubble);
    // 初期位置
    this._positionBubble(bubble);
  },

  _positionBubble(bubble) {
    if (!Game.camera || !bubble.car) return;
    const car = bubble.car;
    const v = new THREE.Vector3(car.x, car.y + 5, car.z);
    // 後方カメラより前にあるかチェック
    const camFwd = new THREE.Vector3();
    Game.camera.getWorldDirection(camFwd);
    const toCar = new THREE.Vector3(v.x - Game.camera.position.x,
                                     v.y - Game.camera.position.y,
                                     v.z - Game.camera.position.z);
    const behind = (camFwd.x * toCar.x + camFwd.y * toCar.y + camFwd.z * toCar.z) < 0;
    v.project(Game.camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    if (behind) {
      bubble.el.style.display = 'none';
    } else {
      bubble.el.style.display = '';
      bubble.el.style.left = x + 'px';
      bubble.el.style.top = y + 'px';
    }
  },

  // メインループから呼ぶ: 期限切れ削除 + 位置更新
  tick() {
    const now = performance.now();
    for (let i = this._activeBubbles.length - 1; i >= 0; i--) {
      const b = this._activeBubbles[i];
      if (now > b.expiresAt) {
        if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
        this._activeBubbles.splice(i, 1);
      } else {
        this._positionBubble(b);
      }
    }
  },
};

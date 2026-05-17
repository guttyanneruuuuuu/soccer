// ============= ミニマップ (上から見たアリーナをcanvas2Dで描画) =============
const Minimap = {
  canvas: null,
  ctx: null,
  pad: 8,

  init() {
    this.canvas = document.getElementById('minimap');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
  },

  draw() {
    if (!this.ctx || !Game.localCar) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    // 背景
    ctx.fillStyle = 'rgba(20,40,60,0.55)';
    ctx.fillRect(0, 0, W, H);

    // アリーナ枠 (Z=縦軸→Y, X=横軸)
    const pad = this.pad;
    const aw = W - pad * 2;
    const ah = H - pad * 2;
    const sx = aw / Arena.W;
    const sz = ah / Arena.L;
    const toMx = (x) => pad + (x + Arena.W / 2) * sx;
    const toMz = (z) => pad + (z + Arena.L / 2) * sz;

    // フィールド緑
    ctx.fillStyle = '#1f4f28';
    ctx.fillRect(toMx(-Arena.W / 2), toMz(-Arena.L / 2), aw, ah);

    // センターライン
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(toMx(-Arena.W / 2), toMz(0));
    ctx.lineTo(toMx(Arena.W / 2), toMz(0));
    ctx.stroke();
    // センターサークル
    ctx.beginPath();
    ctx.arc(toMx(0), toMz(0), 14 * Math.min(sx, sz), 0, Math.PI * 2);
    ctx.stroke();

    // ゴール (青/橙)
    ctx.fillStyle = '#29b6f6';
    ctx.fillRect(toMx(-Arena.GOAL_W / 2), toMz(-Arena.L / 2) - 2,
      Arena.GOAL_W * sx, 4);
    ctx.fillStyle = '#ff7043';
    ctx.fillRect(toMx(-Arena.GOAL_W / 2), toMz(Arena.L / 2) - 2,
      Arena.GOAL_W * sx, 4);

    // ブーストパッド
    for (const p of Arena.boostPads) {
      ctx.fillStyle = p.active
        ? (p.big ? '#ffaa33' : 'rgba(255,235,100,0.7)')
        : 'rgba(100,100,100,0.4)';
      ctx.beginPath();
      ctx.arc(toMx(p.x), toMz(p.z), p.big ? 3 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 車たち
    for (const car of Game.cars.values()) {
      if (car.respawnTimer > 0) continue;
      const isMe = car === Game.localCar;
      const cx = toMx(car.x);
      const cz = toMz(car.z);
      ctx.save();
      ctx.translate(cx, cz);
      ctx.rotate(-car.angle); // canvas y軸はworld -z 軸に近い
      // 三角形 (車向き)
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(-2.6, 3);
      ctx.lineTo(2.6, 3);
      ctx.closePath();
      ctx.fillStyle = isMe ? '#ffffff' : (car.team === 'blue' ? '#29b6f6' : '#ff7043');
      ctx.fill();
      if (isMe) {
        ctx.strokeStyle = car.team === 'blue' ? '#29b6f6' : '#ff7043';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ボール
    const bx = toMx(Game.ball.x);
    const bz = toMz(Game.ball.z);
    ctx.beginPath();
    ctx.arc(bx, bz, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
    // ボール影 (高さ)
    if (Game.ball.y > 4) {
      ctx.beginPath();
      ctx.arc(bx, bz, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
    }
  },
};

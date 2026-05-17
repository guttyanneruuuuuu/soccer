// ============= ボール（ロケットリーグ風の物理） =============
const BallPhys = {
  RADIUS: 2.2,
  GRAVITY: 32,
  AIR_FRICTION: 0.10,    // 空気抵抗 (per sec)
  GROUND_FRICTION: 0.55, // 接地時の摩擦
  WALL_BOUNCE: 0.78,
  FLOOR_BOUNCE: 0.60,
  CEIL_BOUNCE: 0.65,
  MAX_SPEED: 80,
};

class Ball {
  constructor(scene) {
    this.x = 0; this.y = BallPhys.RADIUS; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.spin = 0;       // 見た目用回転
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.lastHitter = null;
    this.lastHitTime = 0;

    // メッシュ
    const geo = new THREE.SphereGeometry(BallPhys.RADIUS, 24, 16);
    const tex = this._makeSoccerTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // 影代わりの円
    const shadowGeo = new THREE.CircleGeometry(BallPhys.RADIUS, 16);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);
  }

  _makeSoccerTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 128);
    // 黒の五角形パッチ風
    ctx.fillStyle = '#222';
    for (let i = 0; i < 12; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      ctx.beginPath();
      const r = 12 + Math.random() * 8;
      const sides = 5;
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  reset(side = 0) {
    this.x = 0; this.y = BallPhys.RADIUS + 8; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.spin = 0;
    this.lastHitter = null;
  }

  update(dt) {
    // 重力
    this.vy -= BallPhys.GRAVITY * dt;
    // 空気抵抗
    const af = Math.pow(1 - BallPhys.AIR_FRICTION, dt);
    this.vx *= af; this.vy *= af; this.vz *= af;

    // 速度上限
    const sp = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    if (sp > BallPhys.MAX_SPEED) {
      const s = BallPhys.MAX_SPEED / sp;
      this.vx *= s; this.vy *= s; this.vz *= s;
    }

    // 位置更新
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    // ===== 床 =====
    if (this.y < BallPhys.RADIUS) {
      this.y = BallPhys.RADIUS;
      if (this.vy < 0) {
        this.vy = -this.vy * BallPhys.FLOOR_BOUNCE;
        // 接地摩擦
        this.vx *= (1 - BallPhys.GROUND_FRICTION * dt * 3);
        this.vz *= (1 - BallPhys.GROUND_FRICTION * dt * 3);
        // 微小バウンドで止める
        if (Math.abs(this.vy) < 1.5) this.vy = 0;
      }
    }

    // ===== 天井 =====
    if (this.y > Arena.H - BallPhys.RADIUS) {
      this.y = Arena.H - BallPhys.RADIUS;
      if (this.vy > 0) this.vy = -this.vy * BallPhys.CEIL_BOUNCE;
    }

    // ===== 側壁 X =====
    if (this.x > Arena.W/2 - BallPhys.RADIUS) {
      this.x = Arena.W/2 - BallPhys.RADIUS;
      if (this.vx > 0) this.vx = -this.vx * BallPhys.WALL_BOUNCE;
    }
    if (this.x < -Arena.W/2 + BallPhys.RADIUS) {
      this.x = -Arena.W/2 + BallPhys.RADIUS;
      if (this.vx < 0) this.vx = -this.vx * BallPhys.WALL_BOUNCE;
    }

    // ===== 短辺 Z (ゴール口を抜けるためチェック) =====
    const inGoalSlot = Math.abs(this.x) <= Arena.GOAL_W/2 - BallPhys.RADIUS
                     && this.y <= Arena.GOAL_H - BallPhys.RADIUS;
    if (this.z > Arena.L/2 - BallPhys.RADIUS && !inGoalSlot) {
      this.z = Arena.L/2 - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    if (this.z < -Arena.L/2 + BallPhys.RADIUS && !inGoalSlot) {
      this.z = -Arena.L/2 + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    // ゴール奥の壁
    const goalBack = Arena.L/2 + Arena.GOAL_DEPTH;
    if (this.z > goalBack - BallPhys.RADIUS) {
      this.z = goalBack - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * 0.4;
    }
    if (this.z < -goalBack + BallPhys.RADIUS) {
      this.z = -goalBack + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * 0.4;
    }

    // ===== 見た目（回転） =====
    const horizSpeed = Math.sqrt(this.vx*this.vx + this.vz*this.vz);
    if (horizSpeed > 0.1) {
      this.spinAxis.set(this.vz, 0, -this.vx).normalize();
      this.spin = horizSpeed / BallPhys.RADIUS;
    }
    this.mesh.rotateOnWorldAxis(this.spinAxis, this.spin * dt);
    this.mesh.position.set(this.x, this.y, this.z);

    // 影位置
    this.shadow.position.set(this.x, 0.06, this.z);
    const shScale = Utils.clamp(1 - this.y / Arena.H * 0.7, 0.3, 1);
    this.shadow.scale.set(shScale, shScale, shScale);
    this.shadow.material.opacity = 0.4 * shScale;
  }

  // 車との衝突: ホストでのみ実行され、結果が同期される
  // ただしソロ・全クライアントの見た目同期のため、ローカルでも衝突を回せる
  collideWithCar(car) {
    const dx = this.x - car.x;
    const dy = this.y - car.y;
    const dz = this.z - car.z;
    const minDist = BallPhys.RADIUS + CarPhys.RADIUS;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 >= minDist * minDist) return 0;
    const d = Math.sqrt(d2) || 0.0001;
    // 押し出し
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const overlap = minDist - d;
    this.x += nx * overlap;
    this.y += ny * overlap;
    this.z += nz * overlap;

    // 車の相対速度
    const rvx = this.vx - car.vx;
    const rvy = this.vy - car.vy;
    const rvz = this.vz - car.vz;
    const dot = rvx*nx + rvy*ny + rvz*nz;
    if (dot < 0) {
      // 反発係数 - 「むっちゃ飛ぶ」ために高め
      const e = 1.45;
      const j = -(1 + e) * dot;
      this.vx += nx * j;
      this.vy += ny * j;
      this.vz += nz * j;
    }
    // 車の前進方向と速度に応じてさらにキック (ヒット感)
    const carSpeedMag = Math.sqrt(car.vx*car.vx + car.vy*car.vy + car.vz*car.vz);
    const kick = 0.55 * carSpeedMag + 12;
    this.vx += nx * kick;
    this.vy += ny * kick + 4; // 少し上方向に持ち上げ
    this.vz += nz * kick;

    // 速度上限
    const sp = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    if (sp > BallPhys.MAX_SPEED) {
      const s = BallPhys.MAX_SPEED / sp;
      this.vx *= s; this.vy *= s; this.vz *= s;
    }

    this.lastHitter = car.id;
    this.lastHitTime = performance.now();
    car.bumpFromBall(carSpeedMag);
    car.ballHitCooldown = 0.12;
    return sp;
  }

  // ゴール判定: ボール中心がゴール領域内に入ったら true
  // 戻り値: 0=なし, 1=+Z側ゴール(青チーム失点 = オレンジ得点), -1=-Z側ゴール
  checkGoal() {
    if (Math.abs(this.x) > Arena.GOAL_W/2) return 0;
    if (this.y > Arena.GOAL_H) return 0;
    if (this.z > Arena.L/2 + 0.2) return 1;
    if (this.z < -Arena.L/2 - 0.2) return -1;
    return 0;
  }

  applyRemoteState(state) {
    // ホストからの権威的状態を適用
    this.x = state.x; this.y = state.y; this.z = state.z;
    this.vx = state.vx; this.vy = state.vy; this.vz = state.vz;
    this.mesh.position.set(this.x, this.y, this.z);
  }

  getNetState() {
    return { x: this.x, y: this.y, z: this.z, vx: this.vx, vy: this.vy, vz: this.vz };
  }
}

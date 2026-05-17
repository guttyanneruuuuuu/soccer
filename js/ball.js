// ============= ボール（風船感 + ロケットリーグ風物理） =============
// 「風船みたいに重力弱め」「車に当たるとむっちゃ飛ぶ」「壁・天井に跳ね返る」を実装。
// ボールも一回り大きく → 半径 3.6 (実物は ~0.93m だがプレイ性優先で大きく)
const BallPhys = {
  RADIUS: 3.6,
  GRAVITY: 14,            // 通常重力38 → ぐっと弱めて空中保持時間を伸ばす
  AIR_FRICTION: 0.06,     // 風船らしく空気抵抗ややあり
  GROUND_FRICTION: 0.5,
  WALL_BOUNCE: 0.95,
  FLOOR_BOUNCE: 0.82,
  CEIL_BOUNCE: 0.84,
  MAX_SPEED: 92,
  // 車衝突時の反発係数 (1.0 以上で「むっちゃ飛ぶ」)
  HIT_RESTITUTION: 1.45,
  // 車速度の何割を追加で乗せるか
  HIT_VEL_TRANSFER: 0.78,
  // 最低キック値 (ヒット感確保)
  HIT_MIN_KICK: 16,
  // 衝突時に上方向に必ず加わる量
  HIT_LIFT: 7.5,
};

class Ball {
  constructor(scene) {
    this.x = 0; this.y = BallPhys.RADIUS; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.spin = 0;
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.lastHitter = null;
    this.lastHitTime = 0;
    this._hitFlashTimer = 0;

    // メッシュ
    const geo = new THREE.SphereGeometry(BallPhys.RADIUS, 32, 20);
    const tex = this._makeSoccerTexture();
    const mat = new THREE.MeshPhongMaterial({
      map: tex, shininess: 30, specular: 0x444444,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this._baseMat = mat;
    scene.add(this.mesh);

    // 影 (リング状でリアルに)
    const shadowGeo = new THREE.CircleGeometry(BallPhys.RADIUS * 1.05, 24);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    // ヒット時のグロー
    const glowGeo = new THREE.SphereGeometry(BallPhys.RADIUS * 1.25, 16, 12);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
    });
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    scene.add(this.glow);

    // ===== トレイル (高速時にカラフルな軌跡) =====
    this._trailPool = [];
    this._trailColors = [0x29b6f6, 0x9c27b0, 0xff7043, 0xffeb3b];
    const TRAIL_SEGMENTS = 14;
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const tg = new THREE.SphereGeometry(BallPhys.RADIUS * 0.85, 10, 8);
      const tm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
      const tmesh = new THREE.Mesh(tg, tm);
      scene.add(tmesh);
      this._trailPool.push(tmesh);
    }
    this._trailIdx = 0;
    this._trailTimer = 0;
  }

  _makeSoccerTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const ctx = c.getContext('2d');
    // 白ベース
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 256);

    // 六角形+五角形パッチ
    ctx.fillStyle = '#181818';
    const drawPolygon = (cx, cy, r, sides, rot = 0) => {
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const a = rot + (i / sides) * Math.PI * 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };
    // 五角形を散らす
    for (let i = 0; i < 18; i++) {
      drawPolygon(Math.random() * 512, Math.random() * 256, 14 + Math.random() * 6, 5, Math.random());
    }
    // 六角形(細く外周)
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      const cx = Math.random() * 512, cy = Math.random() * 256;
      const r = 22;
      for (let j = 0; j < 6; j++) {
        const a = (j / 6) * Math.PI * 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
    return new THREE.CanvasTexture(c);
  }

  reset() {
    this.x = 0; this.y = BallPhys.RADIUS + 12; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.spin = 0;
    this.lastHitter = null;
    this._hitFlashTimer = 0;
    if (this.glow) this.glow.material.opacity = 0;
    // トレイルもクリア
    if (this._trailPool) {
      for (const t of this._trailPool) { t.material.opacity = 0; t._life = 0; }
    }
  }

  update(dt) {
    // 重力 (風船感)
    this.vy -= BallPhys.GRAVITY * dt;
    // 空気抵抗
    const af = Math.pow(1 - BallPhys.AIR_FRICTION, dt);
    this.vx *= af; this.vy *= af; this.vz *= af;

    // 最大速度
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
        this.vx *= (1 - BallPhys.GROUND_FRICTION * dt * 3);
        this.vz *= (1 - BallPhys.GROUND_FRICTION * dt * 3);
        if (Math.abs(this.vy) < 1.2) this.vy = 0;
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

    // ===== 短辺 Z (ゴール口は除外) =====
    const inGoalSlot = Arena.isInGoalSlot(this.x, this.y, BallPhys.RADIUS);
    if (this.z > Arena.L/2 - BallPhys.RADIUS && !inGoalSlot) {
      this.z = Arena.L/2 - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    if (this.z < -Arena.L/2 + BallPhys.RADIUS && !inGoalSlot) {
      this.z = -Arena.L/2 + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    // ゴール奥の壁(ボールがゴール内に入った後の処理)
    const goalBack = Arena.L/2 + Arena.GOAL_DEPTH;
    if (this.z > goalBack - BallPhys.RADIUS) {
      this.z = goalBack - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * 0.72;
    }
    if (this.z < -goalBack + BallPhys.RADIUS) {
      this.z = -goalBack + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * 0.72;
    }

    // ===== コーナー壁 =====
    Arena.resolveCornerCollision(this, BallPhys.RADIUS, BallPhys.WALL_BOUNCE);

    // ===== 見た目（回転） =====
    const horizSpeed = Math.sqrt(this.vx*this.vx + this.vz*this.vz);
    if (horizSpeed > 0.1) {
      this.spinAxis.set(this.vz, 0, -this.vx).normalize();
      this.spin = horizSpeed / BallPhys.RADIUS;
    }
    this.mesh.rotateOnWorldAxis(this.spinAxis, this.spin * dt);
    this.mesh.position.set(this.x, this.y, this.z);

    // 影位置
    this.shadow.position.set(this.x, 0.1, this.z);
    const shScale = Utils.clamp(1 - this.y / Arena.H * 0.65, 0.35, 1.05);
    this.shadow.scale.set(shScale, shScale, shScale);
    this.shadow.material.opacity = 0.45 * shScale;

    // ヒットフラッシュ
    if (this._hitFlashTimer > 0) {
      this._hitFlashTimer -= dt;
      this.glow.position.set(this.x, this.y, this.z);
      this.glow.material.opacity = Math.max(0, this._hitFlashTimer * 1.8);
      const s = 1 + (1 - this._hitFlashTimer) * 0.4;
      this.glow.scale.set(s, s, s);
    } else if (this.glow.material.opacity > 0) {
      this.glow.material.opacity = 0;
    }

    // ===== トレイル: 高速時に色付きの粒子を残す =====
    const speed = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    this._trailTimer -= dt;
    const trailActive = speed > 22;
    if (trailActive && this._trailTimer <= 0) {
      this._trailTimer = 0.035;
      const t = this._trailPool[this._trailIdx];
      const color = this._trailColors[this._trailIdx % this._trailColors.length];
      t.material.color.setHex(color);
      t.material.opacity = Utils.clamp(speed / 60, 0.4, 0.95);
      t.position.set(this.x, this.y, this.z);
      const sc = 0.7 + Utils.clamp(speed / 80, 0, 0.5);
      t.scale.set(sc, sc, sc);
      t._life = 0.45;
      this._trailIdx = (this._trailIdx + 1) % this._trailPool.length;
    }
    // フェードアウト
    for (const t of this._trailPool) {
      if (t._life === undefined) continue;
      if (t._life > 0) {
        t._life -= dt;
        const a = Math.max(0, t._life / 0.45);
        t.material.opacity = t.material.opacity * 0.85 * (a + 0.001);
        const cs = t.scale.x * 0.96;
        t.scale.set(cs, cs, cs);
        if (t._life <= 0) { t.material.opacity = 0; }
      }
    }
  }

  // 車との衝突: 高反発でボールを大きく飛ばす
  collideWithCar(car) {
    const dx = this.x - car.x;
    const dy = this.y - car.y;
    const dz = this.z - car.z;
    const minDist = BallPhys.RADIUS + CarPhys.RADIUS;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 >= minDist * minDist) return 0;
    const d = Math.sqrt(d2) || 0.0001;

    // 押し出し（車側はあまり動かさない）
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const overlap = minDist - d;
    this.x += nx * overlap * 1.0;
    this.y += ny * overlap * 1.0;
    this.z += nz * overlap * 1.0;

    // 相対速度
    const rvx = this.vx - car.vx;
    const rvy = this.vy - car.vy;
    const rvz = this.vz - car.vz;
    const dot = rvx*nx + rvy*ny + rvz*nz;

    // 反発インパルス (法線方向)
    if (dot < 0) {
      const e = BallPhys.HIT_RESTITUTION;
      const j = -(1 + e) * dot;
      this.vx += nx * j;
      this.vy += ny * j;
      this.vz += nz * j;
    }

    // 車の運動量を直接ボールに乗せる（「勢いのある車に当たるとむっちゃ飛ぶ」）
    const carSpeedMag = Math.sqrt(car.vx*car.vx + car.vy*car.vy + car.vz*car.vz);
    // GIANTパワー時はキック力1.7倍
    const giantBoost = (car.activePower === 'giant') ? 1.7 : 1.0;
    const baseKick = (BallPhys.HIT_MIN_KICK + carSpeedMag * BallPhys.HIT_VEL_TRANSFER) * giantBoost;
    this.vx += nx * baseKick;
    this.vy += ny * baseKick + BallPhys.HIT_LIFT * giantBoost;
    this.vz += nz * baseKick;

    // 速度上限
    const sp = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    if (sp > BallPhys.MAX_SPEED) {
      const s = BallPhys.MAX_SPEED / sp;
      this.vx *= s; this.vy *= s; this.vz *= s;
    }

    this.lastHitter = car.id;
    this.lastHitTime = performance.now();
    this._hitFlashTimer = 0.45;
    car.bumpFromBall(carSpeedMag);
    car.ballHitCooldown = 0.1;
    return sp;
  }

  // ゴール判定: ボール中心がゴール領域に入ったら 1/-1 を返す
  checkGoal() {
    if (Math.abs(this.x) > Arena.GOAL_W / 2) return 0;
    if (this.y > Arena.GOAL_H) return 0;
    if (this.z > Arena.L / 2 + 0.4) return 1;     // +Z 側ゴール
    if (this.z < -Arena.L / 2 - 0.4) return -1;   // -Z 側ゴール
    return 0;
  }

  applyRemoteState(state) {
    // クライアントはホストの権威状態を補間で適用
    this.x = Utils.lerp(this.x, state.x, 0.5);
    this.y = Utils.lerp(this.y, state.y, 0.5);
    this.z = Utils.lerp(this.z, state.z, 0.5);
    this.vx = state.vx; this.vy = state.vy; this.vz = state.vz;
    this.mesh.position.set(this.x, this.y, this.z);
  }

  getNetState() {
    return { x: this.x, y: this.y, z: this.z, vx: this.vx, vy: this.vy, vz: this.vz };
  }
}

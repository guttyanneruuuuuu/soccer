// ============= ボール（風船感 + ロケットリーグ風物理） =============
// PDCA7 改善:
//   - トレイルを 14 個の Sphere → 8 個の Sprite に変更 (描画コスト 1/3)
//   - 影 RingGeometry の更新を高度に応じてダイナミックに
//   - スーパーソニックヒット時のリングインパクト演出
//   - 速度上限を超えるベクトルが NaN になりやすかった箇所を堅牢化
const BallPhys = {
  RADIUS: 10.8,
  GRAVITY: 22,            // PDCA6.5: 滞空時間が長すぎたため重力UP (15 → 22) — リモート優先
  AIR_FRICTION: 0.05,     // 風船らしく空気抵抗ややあり
  GROUND_FRICTION: 0.45,
  WALL_BOUNCE: 0.92,
  FLOOR_BOUNCE: 0.66,     // PDCA6.5: バウンドし過ぎを抑制 (0.74 → 0.66) — リモート優先
  CEIL_BOUNCE: 0.68,      // PDCA6.5: 天井反射後の滞空短縮 (0.80 → 0.68) — リモート優先
  MAX_SPEED: 175,         // PDCA7: 速度上限を170→175に微増
  HIT_RESTITUTION: 1.42,
  HIT_VEL_TRANSFER: 0.80, // PDCA7: 0.78 → 0.80 (車の勢いが乗りやすく)
  HIT_MIN_KICK: 17,       // PDCA7: 16 → 17 (打感UP)
  HIT_LIFT: 3.8,          // PDCA6.5: ヒット時上方向成分を抑制 (6.0 → 3.8) — リモート優先
};

class Ball {
  constructor(scene) {
    this.x = 0; this.y = BallPhys.RADIUS; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.spin = 0;
    this.spinAxis = new THREE.Vector3(1, 0, 0);
    this.lastHitter = null;
    this.previousHitter = null;
    this.lastHitTime = 0;
    this._hitFlashTimer = 0;
    this._lastBigHitTime = 0;

    const geo = new THREE.SphereGeometry(BallPhys.RADIUS, 28, 18);
    const tex = this._makeSoccerTexture();
    const mat = new THREE.MeshPhongMaterial({
      map: tex, shininess: 30, specular: 0x444444,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this._baseMat = mat;
    scene.add(this.mesh);

    // 影 (リング状)
    const shadowGeo = new THREE.CircleGeometry(BallPhys.RADIUS * 1.05, 20);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    // ヒット時のグロー
    const glowGeo = new THREE.SphereGeometry(BallPhys.RADIUS * 1.25, 14, 10);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
    });
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    scene.add(this.glow);

    // ===== トレイル: Sprite ベース (頂点コスト最小) =====
    this._trailPool = [];
    this._trailColors = [0x29b6f6, 0x9c27b0, 0xff7043, 0xffeb3b];
    const TRAIL_SEGMENTS = 8; // 14 → 8 に削減
    const trailTexCache = this._makeTrailSpriteTex();
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const sm = new THREE.SpriteMaterial({
        map: trailTexCache,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(sm);
      sp.scale.set(BallPhys.RADIUS * 1.6, BallPhys.RADIUS * 1.6, 1);
      scene.add(sp);
      this._trailPool.push(sp);
    }
    this._trailIdx = 0;
    this._trailTimer = 0;

    // ===== 強打リング (爆速ヒット演出) =====
    const ringGeo = new THREE.RingGeometry(BallPhys.RADIUS * 1.1, BallPhys.RADIUS * 1.4, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    scene.add(ring);
    this._impactRing = ring;
    this._impactRingT = 0;
  }

  _makeTrailSpriteTex() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  _makeSoccerTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 256);

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
    for (let i = 0; i < 18; i++) {
      drawPolygon(Math.random() * 512, Math.random() * 256, 14 + Math.random() * 6, 5, Math.random());
    }
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
    this.previousHitter = null;
    this._hitFlashTimer = 0;
    this._impactRingT = 0;
    if (this.glow) this.glow.material.opacity = 0;
    if (this._impactRing) this._impactRing.material.opacity = 0;
    if (this._trailPool) {
      for (const t of this._trailPool) { t.material.opacity = 0; t._life = 0; }
    }
  }

  update(dt) {
    // 重力
    this.vy -= BallPhys.GRAVITY * dt;
    // 空気抵抗
    const af = Math.pow(1 - BallPhys.AIR_FRICTION, dt);
    this.vx *= af; this.vy *= af; this.vz *= af;

    // 速度上限
    this._clampSpeed();

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

    // 天井
    if (this.y > Arena.H - BallPhys.RADIUS) {
      this.y = Arena.H - BallPhys.RADIUS;
      if (this.vy > 0) this.vy = -this.vy * BallPhys.CEIL_BOUNCE;
    }

    // 側壁 X
    if (this.x > Arena.W/2 - BallPhys.RADIUS) {
      this.x = Arena.W/2 - BallPhys.RADIUS;
      if (this.vx > 0) this.vx = -this.vx * BallPhys.WALL_BOUNCE;
    }
    if (this.x < -Arena.W/2 + BallPhys.RADIUS) {
      this.x = -Arena.W/2 + BallPhys.RADIUS;
      if (this.vx < 0) this.vx = -this.vx * BallPhys.WALL_BOUNCE;
    }

    // 短辺 Z (ゴール口は除外)
    const inGoalSlot = Arena.isInGoalSlot(this.x, this.y, BallPhys.RADIUS);
    if (this.z > Arena.L/2 - BallPhys.RADIUS && !inGoalSlot) {
      this.z = Arena.L/2 - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    if (this.z < -Arena.L/2 + BallPhys.RADIUS && !inGoalSlot) {
      this.z = -Arena.L/2 + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * BallPhys.WALL_BOUNCE;
    }
    // ゴール奥壁
    const goalBack = Arena.L/2 + Arena.GOAL_DEPTH;
    if (this.z > goalBack - BallPhys.RADIUS) {
      this.z = goalBack - BallPhys.RADIUS;
      if (this.vz > 0) this.vz = -this.vz * 0.72;
    }
    if (this.z < -goalBack + BallPhys.RADIUS) {
      this.z = -goalBack + BallPhys.RADIUS;
      if (this.vz < 0) this.vz = -this.vz * 0.72;
    }

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

    // ===== 強打リング演出 =====
    if (this._impactRingT > 0) {
      this._impactRingT -= dt;
      const t = this._impactRingT;
      const s = 1 + (0.6 - t) * 5;
      this._impactRing.position.set(this.x, this.y, this.z);
      this._impactRing.lookAt(
        this.x - (this._impactDir ? this._impactDir.x : 0),
        this.y - (this._impactDir ? this._impactDir.y : 0),
        this.z - (this._impactDir ? this._impactDir.z : 0)
      );
      this._impactRing.scale.set(s, s, s);
      this._impactRing.material.opacity = Math.max(0, t * 1.7);
      if (this._impactRingT <= 0) this._impactRing.material.opacity = 0;
    }

    // ===== トレイル =====
    const speed = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    this._trailTimer -= dt;
    const trailActive = speed > 22;
    if (trailActive && this._trailTimer <= 0) {
      this._trailTimer = 0.045;
      const t = this._trailPool[this._trailIdx];
      const color = this._trailColors[this._trailIdx % this._trailColors.length];
      t.material.color.setHex(color);
      t.material.opacity = Utils.clamp(speed / 60, 0.4, 0.95);
      t.position.set(this.x, this.y, this.z);
      const sc = (0.9 + Utils.clamp(speed / 80, 0, 0.6)) * BallPhys.RADIUS * 1.6;
      t.scale.set(sc, sc, 1);
      t._life = 0.42;
      this._trailIdx = (this._trailIdx + 1) % this._trailPool.length;
    }
    for (const t of this._trailPool) {
      if (t._life === undefined) continue;
      if (t._life > 0) {
        t._life -= dt;
        const a = Math.max(0, t._life / 0.42);
        t.material.opacity = t.material.opacity * 0.88 * (a + 0.001);
        const cs = t.scale.x * 0.96;
        t.scale.set(cs, cs, 1);
        if (t._life <= 0) { t.material.opacity = 0; }
      }
    }
  }

  _clampSpeed() {
    const sp = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    if (!isFinite(sp) || isNaN(sp)) {
      this.vx = this.vy = this.vz = 0;
      return;
    }
    if (sp > BallPhys.MAX_SPEED) {
      const s = BallPhys.MAX_SPEED / sp;
      this.vx *= s; this.vy *= s; this.vz *= s;
    }
  }

  // 車との衝突: 高反発 + 車にも軽い反作用
  collideWithCar(car) {
    const dx = this.x - car.x;
    const dy = this.y - car.y;
    const dz = this.z - car.z;
    const minDist = BallPhys.RADIUS + CarPhys.RADIUS;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 >= minDist * minDist) return 0;
    const d = Math.sqrt(d2) || 0.0001;

    const nx = dx / d, ny = dy / d, nz = dz / d;
    const overlap = minDist - d;
    this.x += nx * overlap * 0.92;
    this.y += ny * overlap * 0.92;
    this.z += nz * overlap * 0.92;
    const carPushback = 0.08;
    car.x -= nx * overlap * carPushback;
    car.z -= nz * overlap * carPushback;
    if (!car.onGround) {
      car.y -= ny * overlap * carPushback;
    }

    const rvx = this.vx - car.vx;
    const rvy = this.vy - car.vy;
    const rvz = this.vz - car.vz;
    const dot = rvx*nx + rvy*ny + rvz*nz;

    if (dot < 0) {
      const e = BallPhys.HIT_RESTITUTION;
      const j = -(1 + e) * dot;
      this.vx += nx * j;
      this.vy += ny * j;
      this.vz += nz * j;
      if (!car.onGround) {
        const carJ = j * 0.08;
        car.vx -= nx * carJ;
        car.vy -= ny * carJ * 0.4;
        car.vz -= nz * carJ;
      }
    }

    const carSpeedMag = Math.sqrt(car.vx*car.vx + car.vy*car.vy + car.vz*car.vz);
    const giantBoost = (car.activePower === 'giant') ? 1.7 : 1.0;
    const ssBoost = car.isSupersonic ? 1.15 : 1.0;
    const baseKick = (BallPhys.HIT_MIN_KICK + carSpeedMag * BallPhys.HIT_VEL_TRANSFER) * giantBoost * ssBoost;
    this.vx += nx * baseKick;
    this.vy += ny * baseKick + BallPhys.HIT_LIFT * giantBoost;
    this.vz += nz * baseKick;

    if (car.isFlipping) {
      const fpx = Math.sin(car.angle);
      const fpz = Math.cos(car.angle);
      this.vx += fpx * 12;
      this.vz += fpz * 12;
      this.vy += 6;
    }

    this._clampSpeed();

    if (this.lastHitter && this.lastHitter !== car.id) {
      this.previousHitter = this.lastHitter;
    }
    this.lastHitter = car.id;
    this.lastHitTime = performance.now();
    this._hitFlashTimer = 0.45;
    // 強ヒットならリング演出
    const finalSpeed = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    if (finalSpeed > 60) {
      this._impactRingT = 0.6;
      this._impactRing.material.opacity = 0.9;
      this._impactDir = { x: nx, y: ny, z: nz };
      this._lastBigHitTime = performance.now();
    }
    car.bumpFromBall(carSpeedMag);
    car.ballHitCooldown = 0.1;
    return finalSpeed;
  }

  checkGoal() {
    if (Math.abs(this.x) > Arena.GOAL_W / 2) return 0;
    if (this.y > Arena.GOAL_H) return 0;
    if (this.z > Arena.L / 2 + 0.4) return 1;
    if (this.z < -Arena.L / 2 - 0.4) return -1;
    return 0;
  }

  applyRemoteState(state) {
    this.x = Utils.lerp(this.x, state.x, 0.5);
    this.y = Utils.lerp(this.y, state.y, 0.5);
    this.z = Utils.lerp(this.z, state.z, 0.5);
    this.vx = state.vx; this.vy = state.vy; this.vz = state.vz;
    this.mesh.position.set(this.x, this.y, this.z);
  }

  clientPredict(dt) {
    this.vy -= BallPhys.GRAVITY * dt;
    const af = Math.pow(1 - BallPhys.AIR_FRICTION, dt);
    this.vx *= af; this.vy *= af; this.vz *= af;
    this._clampSpeed();
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    if (this.y < BallPhys.RADIUS) {
      this.y = BallPhys.RADIUS;
      if (this.vy < 0) this.vy *= -BallPhys.FLOOR_BOUNCE;
    }
    this.mesh.position.set(this.x, this.y, this.z);
    if (this.shadow) {
      this.shadow.position.set(this.x, 0.1, this.z);
      const shScale = Utils.clamp(1 - this.y / Arena.H * 0.65, 0.35, 1.05);
      this.shadow.scale.set(shScale, shScale, shScale);
    }
  }

  getNetState() {
    return { x: this.x, y: this.y, z: this.z, vx: this.vx, vy: this.vy, vz: this.vz };
  }
}

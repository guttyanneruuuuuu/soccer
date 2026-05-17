// ============= 車（プレイヤー / リモート 共通モデル） =============
// racegameの車体メッシュを流用し、ロケットリーグ風の物理を実装
const CarPhys = {
  MAX_SPEED: 38,         // m/s 通常最大
  MAX_SPEED_BOOST: 60,   // ブースト時
  ACCEL: 30,
  REVERSE_ACCEL: 18,
  BRAKE: 50,
  FRICTION: 3.2,
  AIR_FRICTION: 0.4,
  STEER_SPEED: 3.2,      // rad/s 最大
  STEER_AT_SPEED: 0.40,  // 高速時の効き
  LATERAL_GRIP: 9.0,
  RADIUS: 1.5,           // 衝突半径
  HEIGHT: 1.1,           // 床から車中心までのy
  GRAVITY: 38,
  JUMP_VEL: 18,
  DOUBLE_JUMP_VEL: 16,
  BOOST_FORCE: 55,
  BOOST_PER_SEC: 33,     // ブースト消費 (約3秒で空)
  BOOST_MAX: 100,
};

class Car {
  constructor(opts = {}) {
    this.id = opts.id || 'p';
    this.name = opts.name || 'Player';
    this.color = opts.color || '#E53935';
    this.team = opts.team || 'blue';     // 'blue' | 'orange'
    this.isLocal = !!opts.isLocal;
    this.isRemote = !!opts.isRemote;

    // 位置・速度
    this.x = opts.x || 0;
    this.y = CarPhys.HEIGHT;
    this.z = opts.z || 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.angle = opts.angle || 0;          // Y軸回転(ヨー)
    this.pitch = 0;                        // 空中の回転(見た目用)
    this.roll = 0;

    // ステアリング・速度
    this.speed = 0;     // 前進方向の速度成分
    this.onGround = true;

    // ジャンプ
    this.jumpsUsed = 0;     // 0,1,2 (ダブルジャンプまで)
    this.airTime = 0;

    // ブースト
    this.boost = 33;        // 初期値
    this.boostMax = CarPhys.BOOST_MAX;

    // ボール衝突クールダウン
    this.ballHitCooldown = 0;

    // ゴール後の入力ロック
    this.lockTimer = 0;

    this.mesh = this._buildMesh();
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.angle;
  }

  _buildMesh() {
    const group = new THREE.Group();
    const colorHex = parseInt(this.color.replace('#',''), 16);

    // ボディ
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.55, 3.4),
      new THREE.MeshLambertMaterial({ color: colorHex })
    );
    body.position.y = -0.3;  // 車中心(y=0)に対して下
    body.castShadow = true;
    group.add(body);
    this._bodyMesh = body;

    // ノーズ
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.4, 0.8),
      new THREE.MeshLambertMaterial({ color: colorHex })
    );
    nose.position.set(0, -0.35, 1.85);
    group.add(nose);

    // キャビン
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.65, 1.7),
      new THREE.MeshLambertMaterial({ color: 0xfafafa })
    );
    cabin.position.set(0, 0.3, -0.15);
    cabin.castShadow = true;
    group.add(cabin);

    // 窓
    const winMat = new THREE.MeshLambertMaterial({ color: 0x29384a });
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.1), winMat);
    win.position.set(0, 0.3, 0.75);
    group.add(win);
    const winR = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.1), winMat);
    winR.position.set(0, 0.3, -1.05);
    group.add(winR);

    // スポイラー
    const spoiler = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.12, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x222222 })
    );
    spoiler.position.set(0, 0.4, -1.65);
    group.add(spoiler);
    const standMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const stL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, 0.15), standMat);
    stL.position.set(-0.7, 0.2, -1.55);
    const stR = stL.clone(); stR.position.x = 0.7;
    group.add(stL, stR);

    // ヘッドライト
    const lightGeo = new THREE.BoxGeometry(0.32, 0.22, 0.1);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfffae6 });
    const hl1 = new THREE.Mesh(lightGeo, lightMat); hl1.position.set(-0.55, -0.28, 2.22); group.add(hl1);
    const hl2 = new THREE.Mesh(lightGeo, lightMat); hl2.position.set( 0.55, -0.28, 2.22); group.add(hl2);

    // テール
    const tlMat = new THREE.MeshBasicMaterial({ color: 0xd32f2f });
    const tl1 = new THREE.Mesh(lightGeo, tlMat); tl1.position.set(-0.55, -0.28, -1.78); group.add(tl1);
    const tl2 = new THREE.Mesh(lightGeo, tlMat); tl2.position.set( 0.55, -0.28, -1.78); group.add(tl2);

    // タイヤ
    const tireGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.42, 14);
    const tireMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const rimGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.44, 8);
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
    const tirePos = [
      [-0.98, -0.34,  1.15],
      [ 0.98, -0.34,  1.15],
      [-0.98, -0.34, -1.15],
      [ 0.98, -0.34, -1.15],
    ];
    this.tires = [];
    tirePos.forEach(p => {
      const tg = new THREE.Group();
      const t = new THREE.Mesh(tireGeo, tireMat);
      t.rotation.z = Math.PI / 2;
      t.castShadow = true;
      const r = new THREE.Mesh(rimGeo, rimMat);
      r.rotation.z = Math.PI / 2;
      tg.add(t, r);
      tg.position.set(...p);
      group.add(tg);
      this.tires.push(tg);
    });

    // チームインジケーター(ルーフ)
    const teamColor = this.team === 'blue' ? 0x29b6f6 : 0xff7043;
    const teamFlag = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.08, 1.4),
      new THREE.MeshBasicMaterial({ color: teamColor })
    );
    teamFlag.position.set(0, 0.66, -0.15);
    group.add(teamFlag);

    // ブースト炎エフェクト
    const flameGeo = new THREE.ConeGeometry(0.38, 1.6, 8);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9800, transparent: true, opacity: 0.9 });
    const fl1 = new THREE.Mesh(flameGeo, flameMat);
    fl1.position.set(-0.5, -0.25, -2.1); fl1.rotation.x = -Math.PI / 2; fl1.visible = false;
    const fl2 = new THREE.Mesh(flameGeo, flameMat);
    fl2.position.set( 0.5, -0.25, -2.1); fl2.rotation.x = -Math.PI / 2; fl2.visible = false;
    group.add(fl1, fl2);
    this.flames = [fl1, fl2];

    // 名前ラベル
    this.nameSprite = this._buildLabel(this.name);
    this.nameSprite.position.set(0, 1.8, 0);
    group.add(this.nameSprite);

    return group;
  }

  _buildLabel(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = this.team === 'blue' ? '#29b6f6' : '#ff7043';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 10), 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(3, 0.75, 1);
    return sp;
  }

  // 入力に基づいて状態更新 (ローカル車のみ)
  update(dt, input) {
    if (this.lockTimer > 0) {
      this.lockTimer -= dt;
      input = null; // 入力無効
    }

    // ===== 操舵 =====
    if (input) {
      // 速度依存ステアリング: 高速ほど効きが下がる
      const speedRatio = Math.min(1, Math.abs(this.speed) / CarPhys.MAX_SPEED);
      const steerEffect = (1 - speedRatio * (1 - CarPhys.STEER_AT_SPEED));
      // 地上のみハンドル
      if (this.onGround) {
        this.angle += input.steer * CarPhys.STEER_SPEED * steerEffect * dt;
      } else {
        // 空中: エアロール (左右で機体を傾けるだけ、見た目)
        this.roll += input.steer * 2.5 * dt;
      }
    }

    // ===== 加速・ブレーキ =====
    if (input && this.onGround) {
      if (input.accel) {
        this.speed += CarPhys.ACCEL * dt;
      } else if (input.brake) {
        if (this.speed > 0) this.speed -= CarPhys.BRAKE * dt;
        else this.speed -= CarPhys.REVERSE_ACCEL * dt;
      } else {
        // フリクション
        const f = CarPhys.FRICTION * dt;
        if (this.speed > 0) this.speed = Math.max(0, this.speed - f);
        else this.speed = Math.min(0, this.speed + f);
      }
    }

    // ===== ブースト =====
    let boosting = false;
    if (input && input.boost && this.boost > 0) {
      boosting = true;
      this.boost = Math.max(0, this.boost - CarPhys.BOOST_PER_SEC * dt);
      // 前進方向に強い加速
      const fx = Math.sin(this.angle), fz = Math.cos(this.angle);
      if (this.onGround) {
        this.speed += CarPhys.BOOST_FORCE * 0.6 * dt;
      } else {
        // 空中: 機体前方に推力（速度ベクトルを向ける）
        this.vx += fx * CarPhys.BOOST_FORCE * dt;
        this.vz += fz * CarPhys.BOOST_FORCE * dt;
      }
    }
    // 炎エフェクト
    this.flames[0].visible = boosting;
    this.flames[1].visible = boosting;
    if (boosting) {
      const s = 0.8 + Math.random() * 0.6;
      this.flames[0].scale.set(1, s, 1);
      this.flames[1].scale.set(1, s, 1);
    }

    // ===== 最大速度クランプ =====
    const maxV = boosting ? CarPhys.MAX_SPEED_BOOST : CarPhys.MAX_SPEED;
    if (this.speed > maxV) this.speed = maxV;
    if (this.speed < -CarPhys.MAX_SPEED * 0.5) this.speed = -CarPhys.MAX_SPEED * 0.5;

    // ===== ジャンプ =====
    if (input) {
      if (this.onGround && input.jump) {
        this.vy = CarPhys.JUMP_VEL;
        this.onGround = false;
        this.jumpsUsed = 1;
        this.airTime = 0;
      } else if (!this.onGround && this.jumpsUsed < 2 && input.jump) {
        this.vy = CarPhys.DOUBLE_JUMP_VEL;
        this.jumpsUsed = 2;
        // ダブルジャンプはピッチも与えて見た目フリップ
        this.pitch += Math.PI * 0.6;
      }
    }

    // ===== 地上速度をベクトル化 =====
    if (this.onGround) {
      this.vx = Math.sin(this.angle) * this.speed;
      this.vz = Math.cos(this.angle) * this.speed;
      this.vy = 0;
      this.y = CarPhys.HEIGHT;
    } else {
      // 空中: 重力、空気抵抗
      this.vy -= CarPhys.GRAVITY * dt;
      this.vx *= (1 - CarPhys.AIR_FRICTION * dt);
      this.vz *= (1 - CarPhys.AIR_FRICTION * dt);
      this.airTime += dt;
    }

    // ===== 位置更新 =====
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    // ===== 壁・床・天井衝突 =====
    this._resolveArenaCollisions();

    // ===== 着地 =====
    if (this.y <= CarPhys.HEIGHT) {
      this.y = CarPhys.HEIGHT;
      this.vy = 0;
      if (!this.onGround) {
        this.onGround = true;
        this.jumpsUsed = 0;
        // 着地時speed = vxz合成（角度方向成分）
        this.speed = this.vx * Math.sin(this.angle) + this.vz * Math.cos(this.angle);
        // 機体をリセット
        this.pitch = 0;
        this.roll = 0;
      }
    } else {
      this.onGround = false;
    }

    // ===== ブーストパッド吸収 =====
    if (this.onGround) {
      const got = Arena.consumePad(this.x, this.z);
      if (got > 0) {
        this.boost = Math.min(this.boostMax, this.boost + got);
      }
    }

    // ===== クールダウン =====
    if (this.ballHitCooldown > 0) this.ballHitCooldown -= dt;

    // ===== タイヤ回転（見た目） =====
    const wheelSpin = this.speed * dt * 1.6;
    for (const t of this.tires) t.rotation.x += wheelSpin;
    // 前輪を steer 方向に少し向ける（入力ある場合）
    if (input) {
      const steerLook = input.steer * 0.4;
      this.tires[0].rotation.y = steerLook;
      this.tires[1].rotation.y = steerLook;
    }

    // メッシュに反映
    this.syncMesh();
  }

  syncMesh() {
    this.mesh.position.set(this.x, this.y, this.z);
    // YXZオイラー: yaw -> pitch -> roll
    this.mesh.rotation.order = 'YXZ';
    this.mesh.rotation.y = this.angle;
    this.mesh.rotation.x = this.pitch;
    this.mesh.rotation.z = this.roll;
  }

  _resolveArenaCollisions() {
    const r = CarPhys.RADIUS;
    // 側壁 X
    if (this.x > Arena.W/2 - r) {
      this.x = Arena.W/2 - r;
      if (this.vx > 0) this.vx = -this.vx * 0.4;
      this.speed *= 0.5;
    }
    if (this.x < -Arena.W/2 + r) {
      this.x = -Arena.W/2 + r;
      if (this.vx < 0) this.vx = -this.vx * 0.4;
      this.speed *= 0.5;
    }
    // 短辺 Z (ゴール口は除外)
    const inGoalSlot = Math.abs(this.x) <= Arena.GOAL_W/2 - r && this.y <= Arena.GOAL_H - r;
    if (this.z > Arena.L/2 - r && !inGoalSlot) {
      this.z = Arena.L/2 - r;
      if (this.vz > 0) this.vz = -this.vz * 0.4;
      this.speed *= 0.5;
    }
    if (this.z < -Arena.L/2 + r && !inGoalSlot) {
      this.z = -Arena.L/2 + r;
      if (this.vz < 0) this.vz = -this.vz * 0.4;
      this.speed *= 0.5;
    }
    // 天井
    if (this.y > Arena.H - r) {
      this.y = Arena.H - r;
      if (this.vy > 0) this.vy = -this.vy * 0.4;
    }
  }

  // リモート車の補間用
  applyRemoteState(state) {
    // 単純なlerp
    this.x = Utils.lerp(this.x, state.x, 0.35);
    this.y = Utils.lerp(this.y, state.y, 0.35);
    this.z = Utils.lerp(this.z, state.z, 0.35);
    // 角度はlerpで急変緩和
    let da = state.angle - this.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.angle += da * 0.35;
    this.pitch = state.pitch || 0;
    this.roll = state.roll || 0;
    this.vx = state.vx || 0;
    this.vy = state.vy || 0;
    this.vz = state.vz || 0;
    this.speed = state.speed || 0;
    this.boost = state.boost ?? this.boost;
    this.onGround = !!state.onGround;
    // 炎
    this.flames[0].visible = !!state.boosting;
    this.flames[1].visible = !!state.boosting;
    this.syncMesh();
  }

  getNetState(boostingNow = false) {
    return {
      id: this.id,
      x: this.x, y: this.y, z: this.z,
      vx: this.vx, vy: this.vy, vz: this.vz,
      angle: this.angle, pitch: this.pitch, roll: this.roll,
      speed: this.speed, boost: this.boost, onGround: this.onGround,
      boosting: boostingNow,
    };
  }

  // ボール衝突適用後の見た目飛び跳ね用
  bumpFromBall(power) {
    // 軽い揺れ
    this.pitch += (Math.random() - 0.5) * 0.3 * Math.min(1, power / 30);
    this.roll  += (Math.random() - 0.5) * 0.3 * Math.min(1, power / 30);
  }
}

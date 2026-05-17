// ============= 車（racegame の車体メッシュを流用し、ロケットリーグ風物理を実装） =============
// 「車も一回り大きく」「ジャイロのみで操作」「自動アクセル」「ジャンプボタンのみ」を実現。
// アクセル: 自動 ON。ブレーキ/バック: ジャイロのピッチ (端末を後ろに傾ける) で発動。
const CarPhys = {
  // サイズ (一回り大きく: 操作中車をでかく見せるため少し大きく)
  RADIUS: 4.8,
  HEIGHT: 3.4,

  // 速度パラメタ (操作感アップ)
  MAX_SPEED: 50,          // m/s 通常最大 (180 km/h)
  MAX_SPEED_BOOST: 78,    // ブースト時 (280 km/h)
  ACCEL: 44,              // 38 → 44 (キビキビ)
  REVERSE_ACCEL: 26,
  BRAKE: 72,              // 60 → 72
  FRICTION: 2.4,
  AIR_FRICTION: 0.28,
  STEER_SPEED: 3.6,       // 3.0 → 3.6 (ハンドリング鋭く)
  STEER_AT_SPEED: 0.55,   // 高速時もそこそこ効く
  LATERAL_GRIP: 11.0,

  // 物理 (ジャンプ強化)
  GRAVITY: 42,
  JUMP_VEL: 31,           // 初段でおよそ y+11 前後まで上がる体感に調整
  DOUBLE_JUMP_VEL: 27,    // 2段目でも高度をしっかり維持できる値に調整
  AIR_PITCH_SPEED: 5.2,   // 空中ピッチ速度アップ
  AIR_ROLL_SPEED: 5.2,    // 空中ロール速度アップ

  // ブースト (もう少し強く・出る量も多く)
  BOOST_FORCE: 88,
  BOOST_PER_SEC: 32,
  BOOST_MAX: 100,
  BOOST_INITIAL: 50,      // 33 → 50 (試合開始で動きやすく)
};

class Car {
  constructor(opts = {}) {
    this.id = opts.id || 'p';
    this.name = opts.name || 'Player';
    this.color = opts.color || '#E53935';
    this.team = opts.team || 'blue';
    this.isLocal = !!opts.isLocal;
    this.isRemote = !!opts.isRemote;

    // 位置・速度
    this.x = opts.x || 0;
    this.y = CarPhys.HEIGHT;
    this.z = opts.z || 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.angle = opts.angle || 0;    // Y軸回転(ヨー)
    this.pitch = 0;
    this.roll = 0;

    this.speed = 0;
    this.onGround = true;

    // ジャンプ
    this.jumpsUsed = 0;
    this.airTime = 0;

    // ブースト
    this.boost = CarPhys.BOOST_INITIAL;
    this.boostMax = CarPhys.BOOST_MAX;

    // ボールとの衝突クールダウン
    this.ballHitCooldown = 0;

    // ゴール後の入力ロック
    this.lockTimer = 0;

    // 反射衝突カウンタ
    this.lastDemoTime = 0;

    // デモリッション後リスポーン
    this.respawnTimer = 0;
    this._spawnX = opts.x || 0;
    this._spawnZ = opts.z || 0;
    this._spawnAngle = opts.angle || 0;

    this.mesh = this._buildMesh();
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.angle;
  }

  _buildMesh() {
    const group = new THREE.Group();
    const colorHex = parseInt(this.color.replace('#',''), 16);

    // ロケットリーグ風: 平たくワイドに。スケールアップして「でかく見せる」
    const S = 3.4;

    // ボディ
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.8 * S, 0.55 * S, 3.4 * S),
      new THREE.MeshLambertMaterial({ color: colorHex })
    );
    body.position.y = -0.3 * S;
    body.castShadow = true;
    group.add(body);

    // ノーズ
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(1.6 * S, 0.4 * S, 0.8 * S),
      new THREE.MeshLambertMaterial({ color: colorHex })
    );
    nose.position.set(0, -0.35 * S, 1.85 * S);
    group.add(nose);

    // キャビン (チームカラー)
    const teamCabin = this.team === 'blue' ? 0x6ec6ff : 0xff9e80;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.35 * S, 0.65 * S, 1.7 * S),
      new THREE.MeshLambertMaterial({ color: teamCabin })
    );
    cabin.position.set(0, 0.3 * S, -0.15 * S);
    cabin.castShadow = true;
    group.add(cabin);

    // 窓
    const winMat = new THREE.MeshLambertMaterial({ color: 0x162234 });
    const winF = new THREE.Mesh(new THREE.BoxGeometry(1.3 * S, 0.5 * S, 0.1 * S), winMat);
    winF.position.set(0, 0.3 * S, 0.75 * S);
    group.add(winF);
    const winR = new THREE.Mesh(new THREE.BoxGeometry(1.3 * S, 0.5 * S, 0.1 * S), winMat);
    winR.position.set(0, 0.3 * S, -1.05 * S);
    group.add(winR);

    // スポイラー
    const spoiler = new THREE.Mesh(
      new THREE.BoxGeometry(1.8 * S, 0.12 * S, 0.4 * S),
      new THREE.MeshLambertMaterial({ color: 0x222222 })
    );
    spoiler.position.set(0, 0.4 * S, -1.65 * S);
    group.add(spoiler);
    const standMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const stL = new THREE.Mesh(new THREE.BoxGeometry(0.15 * S, 0.4 * S, 0.15 * S), standMat);
    stL.position.set(-0.7 * S, 0.2 * S, -1.55 * S);
    const stR = stL.clone(); stR.position.x = 0.7 * S;
    group.add(stL, stR);

    // ヘッドライト
    const lightGeo = new THREE.BoxGeometry(0.32 * S, 0.22 * S, 0.1 * S);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfffae6 });
    const hl1 = new THREE.Mesh(lightGeo, lightMat); hl1.position.set(-0.55 * S, -0.28 * S, 2.22 * S); group.add(hl1);
    const hl2 = new THREE.Mesh(lightGeo, lightMat); hl2.position.set( 0.55 * S, -0.28 * S, 2.22 * S); group.add(hl2);

    // テールランプ
    const tlMat = new THREE.MeshBasicMaterial({ color: 0xd32f2f });
    const tl1 = new THREE.Mesh(lightGeo, tlMat); tl1.position.set(-0.55 * S, -0.28 * S, -1.78 * S); group.add(tl1);
    const tl2 = new THREE.Mesh(lightGeo, tlMat); tl2.position.set( 0.55 * S, -0.28 * S, -1.78 * S); group.add(tl2);

    // タイヤ
    const tireGeo = new THREE.CylinderGeometry(0.46 * S, 0.46 * S, 0.42 * S, 14);
    const tireMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const rimGeo = new THREE.CylinderGeometry(0.28 * S, 0.28 * S, 0.44 * S, 8);
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
    const tirePos = [
      [-0.98 * S, -0.34 * S,  1.15 * S],
      [ 0.98 * S, -0.34 * S,  1.15 * S],
      [-0.98 * S, -0.34 * S, -1.15 * S],
      [ 0.98 * S, -0.34 * S, -1.15 * S],
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
      new THREE.BoxGeometry(1.2 * S, 0.08 * S, 1.4 * S),
      new THREE.MeshBasicMaterial({ color: teamColor })
    );
    teamFlag.position.set(0, 0.66 * S, -0.15 * S);
    group.add(teamFlag);

    // ブースト炎 (改良: 2 段重ね + チームカラー)
    const teamFlameColor = this.team === 'blue' ? 0x29b6f6 : 0xff7043;
    const flameGeo = new THREE.ConeGeometry(0.52 * S, 2.4 * S, 12);
    const flameMatOuter = new THREE.MeshBasicMaterial({
      color: teamFlameColor, transparent: true, opacity: 0.85,
    });
    const flameMatInner = new THREE.MeshBasicMaterial({
      color: 0xffffe0, transparent: true, opacity: 0.98,
    });
    const fl1 = new THREE.Mesh(flameGeo, flameMatOuter);
    fl1.position.set(-0.5 * S, -0.25 * S, -2.35 * S); fl1.rotation.x = -Math.PI / 2; fl1.visible = false;
    const fl2 = new THREE.Mesh(flameGeo, flameMatOuter);
    fl2.position.set( 0.5 * S, -0.25 * S, -2.35 * S); fl2.rotation.x = -Math.PI / 2; fl2.visible = false;
    // インナー（短く明るく）
    const flameInnerGeo = new THREE.ConeGeometry(0.32 * S, 1.5 * S, 10);
    const fl1i = new THREE.Mesh(flameInnerGeo, flameMatInner);
    fl1i.position.set(-0.5 * S, -0.25 * S, -2.1 * S); fl1i.rotation.x = -Math.PI / 2; fl1i.visible = false;
    const fl2i = new THREE.Mesh(flameInnerGeo, flameMatInner);
    fl2i.position.set( 0.5 * S, -0.25 * S, -2.1 * S); fl2i.rotation.x = -Math.PI / 2; fl2i.visible = false;
    group.add(fl1, fl2, fl1i, fl2i);
    this.flames = [fl1, fl2];
    this.flamesInner = [fl1i, fl2i];

    // ===== 車下部のグロー (ローカル車にのみ装着) =====
    if (this.isLocal) {
      const underGlowGeo = new THREE.PlaneGeometry(2.4 * S, 4.0 * S);
      const teamGlowColor = this.team === 'blue' ? 0x29b6f6 : 0xff7043;
      const underGlowMat = new THREE.MeshBasicMaterial({
        color: teamGlowColor, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
      });
      const underGlow = new THREE.Mesh(underGlowGeo, underGlowMat);
      underGlow.rotation.x = -Math.PI / 2;
      underGlow.position.y = -0.55 * S;
      group.add(underGlow);
      this.underGlow = underGlow;
    }

    // ラベル
    this.nameSprite = this._buildLabel(this.name);
    this.nameSprite.position.set(0, 2.2 * S, 0);
    group.add(this.nameSprite);

    return group;
  }

  _buildLabel(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = this.team === 'blue' ? '#7ec8f7' : '#ffa18a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(text).slice(0, 10), 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(3.6, 0.9, 1);
    return sp;
  }

  // 入力に基づいて状態更新
  update(dt, input) {
    if (this.lockTimer > 0) {
      this.lockTimer -= dt;
      input = null;
    }

    // === デモリッション後リスポーン処理 ===
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      this.vx = this.vy = this.vz = 0;
      this.speed = 0;
      if (this.respawnTimer <= 0) {
        // リスポーン: 自陣付近に復帰
        this.x = this._spawnX;
        this.z = this._spawnZ;
        this.y = CarPhys.HEIGHT;
        this.angle = this._spawnAngle;
        this.pitch = 0; this.roll = 0;
        this.boost = Math.max(this.boost, CarPhys.BOOST_INITIAL);
        this.mesh.visible = true;
        this.onGround = true;
        this.jumpsUsed = 0;
      }
      this.syncMesh();
      return;
    }

    // ===== 操舵 =====
    if (input) {
      const speedRatio = Math.min(1, Math.abs(this.speed) / CarPhys.MAX_SPEED);
      const steerEffect = (1 - speedRatio * (1 - CarPhys.STEER_AT_SPEED));
      if (this.onGround) {
        // 地上はヨー (ハンドル) — 後進中は逆向きに効くと自然
        const dir = this.speed >= 0 ? 1 : -1;
        this.angle += input.steer * CarPhys.STEER_SPEED * steerEffect * dir * dt;
        // 地上のロール演出 (見た目だけ。コーナリングで車体が傾く)
        const targetRoll = -input.steer * Math.min(0.18, Math.abs(this.speed) / CarPhys.MAX_SPEED * 0.25);
        this.roll = Utils.lerp(this.roll, targetRoll, dt * 6);
      } else {
        // 空中: ジャイロのsteer をエア・ヨー(横回転) として使う
        // ピッチ(縦回転)は input.brake(後傾)で上向き、加速トリガー(前傾)で下向き
        // → ジャイロのpitchは Input.pitch から取れるので利用する
        this.angle += input.steer * CarPhys.AIR_ROLL_SPEED * 0.85 * dt;
        // 軽くロールで見た目変化
        const targetRoll = -input.steer * 0.5;
        this.roll = Utils.lerp(this.roll, targetRoll, dt * 5);
        // 空中ピッチ: Input.pitch が利用可能なら使う (端末を起こす=機首上げ)
        const airPitchInput = (typeof Input !== 'undefined') ? (Input.pitch || 0) : 0;
        // input.brake もピッチアップ補助
        const pitchSteer = airPitchInput + (input.brake ? 0.6 : 0);
        this.pitch += pitchSteer * CarPhys.AIR_PITCH_SPEED * dt;
        // ピッチを±π/2 にクランプ (機首が下方向に1回転すると挙動が壊れる)
        if (this.pitch > Math.PI) this.pitch -= Math.PI * 2;
        if (this.pitch < -Math.PI) this.pitch += Math.PI * 2;
      }
    }

    // ===== アクセル入力 + ピッチによるブレーキ =====
    // input.accel (ACCELボタン/キー) で前進。input.brake (ジャイロ後傾) で減速/バック。
    if (input && this.onGround) {
      if (input.brake) {
        if (this.speed > 0) this.speed -= CarPhys.BRAKE * dt;
        else this.speed -= CarPhys.REVERSE_ACCEL * dt;
      } else if (input.accel) {
        this.speed += CarPhys.ACCEL * dt;
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
      // 前進方向(車の向き)に推力
      const fx = Math.sin(this.angle), fz = Math.cos(this.angle);
      if (this.onGround) {
        this.speed += CarPhys.BOOST_FORCE * 0.6 * dt;
      } else {
        // 空中はベクトル推力 (前方)
        // 機体ピッチも反映する: 前方ベクトルを (cos pitch * fx, -sin pitch, cos pitch * fz) に
        const cp = Math.cos(this.pitch);
        const sp_ = Math.sin(this.pitch);
        this.vx += fx * cp * CarPhys.BOOST_FORCE * dt;
        this.vy += -sp_  * CarPhys.BOOST_FORCE * dt;
        this.vz += fz * cp * CarPhys.BOOST_FORCE * dt;
      }
    }

    // 炎エフェクト
    for (const f of this.flames) f.visible = boosting;
    for (const f of this.flamesInner) f.visible = boosting;
    if (boosting) {
      const s = 0.85 + Math.random() * 0.4;
      this.flames[0].scale.set(1, s, 1); this.flames[1].scale.set(1, s, 1);
      const si = 0.75 + Math.random() * 0.3;
      this.flamesInner[0].scale.set(1, si, 1); this.flamesInner[1].scale.set(1, si, 1);
    }

    // ===== 最大速度クランプ =====
    const maxV = boosting ? CarPhys.MAX_SPEED_BOOST : CarPhys.MAX_SPEED;
    if (this.speed > maxV) this.speed = maxV;
    if (this.speed < -CarPhys.MAX_SPEED * 0.5) this.speed = -CarPhys.MAX_SPEED * 0.5;

    // ===== ジャンプ (スプリングパワー所持で2倍 & 3段) =====
    const isSpring = this.activePower === 'spring';
    const jumpMult = isSpring ? 1.8 : 1;
    const maxJumps = isSpring ? 3 : 2;
    if (input) {
      if (this.onGround && input.jump) {
        this.vy = CarPhys.JUMP_VEL * jumpMult;
        this.onGround = false;
        this.jumpsUsed = 1;
        this.airTime = 0;
      } else if (!this.onGround && this.jumpsUsed < maxJumps && input.jump) {
        // ダブルジャンプ: フリップ風 (前方向に少し推進力 + ピッチ)
        this.vy = CarPhys.DOUBLE_JUMP_VEL * jumpMult;
        this.jumpsUsed++;
        // 進行方向にブースト
        const fx = Math.sin(this.angle), fz = Math.cos(this.angle);
        this.vx += fx * 10;
        this.vz += fz * 10;
        // ピッチ回転 (見た目フリップ)
        this.pitch += Math.PI * 0.65;
      }
    }

    // ===== 地上速度をベクトル化 =====
    if (this.onGround) {
      this.vx = Math.sin(this.angle) * this.speed;
      this.vz = Math.cos(this.angle) * this.speed;
      this.vy = 0;
      this.y = CarPhys.HEIGHT;
    } else {
      // 空中: 重力 + 空気抵抗
      this.vy -= CarPhys.GRAVITY * dt;
      this.vx *= (1 - CarPhys.AIR_FRICTION * dt);
      this.vz *= (1 - CarPhys.AIR_FRICTION * dt);
      this.airTime += dt;
    }

    // ===== 位置更新 =====
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    // ===== 壁/天井/コーナー衝突 =====
    this._resolveArenaCollisions();

    // ===== 着地 =====
    if (this.y <= CarPhys.HEIGHT) {
      this.y = CarPhys.HEIGHT;
      this.vy = 0;
      if (!this.onGround) {
        this.onGround = true;
        this.jumpsUsed = 0;
        // 着地時 speed = 前進方向成分
        this.speed = this.vx * Math.sin(this.angle) + this.vz * Math.cos(this.angle);
        // 機体姿勢: 上下逆転していれば一気にリセット、そうでなければスムーズに
        if (Math.abs(this.pitch) > Math.PI / 2 + 0.4 || Math.abs(this.roll) > Math.PI / 2 + 0.4) {
          // ハードランディング (一瞬スピード減)
          this.speed *= 0.55;
          if (typeof Game !== 'undefined' && this.isLocal) Game.addCamShake && Game.addCamShake(0.35);
        }
        this.pitch = 0;
        this.roll = 0;
      }
    } else {
      this.onGround = false;
    }

    // ===== ブーストパッド =====
    if (this.onGround) {
      const got = Arena.consumePad(this.x, this.z);
      if (got > 0) {
        this.boost = Math.min(this.boostMax, this.boost + got);
      }
    }

    // ===== クールダウン =====
    if (this.ballHitCooldown > 0) this.ballHitCooldown -= dt;

    // ===== タイヤ回転 (見た目) =====
    const wheelSpin = this.speed * dt * 1.4;
    for (const t of this.tires) t.rotation.x += wheelSpin;
    if (input) {
      const steerLook = input.steer * 0.45;
      this.tires[0].rotation.y = steerLook;
      this.tires[1].rotation.y = steerLook;
    }

    this.syncMesh();
  }

  syncMesh() {
    this.mesh.position.set(this.x, this.y, this.z);
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
      this.speed *= 0.55;
    }
    if (this.x < -Arena.W/2 + r) {
      this.x = -Arena.W/2 + r;
      if (this.vx < 0) this.vx = -this.vx * 0.4;
      this.speed *= 0.55;
    }
    // 短辺 Z (ゴール口除外)
    const inGoalSlot = Arena.isInGoalSlot(this.x, this.y, r);
    if (this.z > Arena.L/2 - r && !inGoalSlot) {
      this.z = Arena.L/2 - r;
      if (this.vz > 0) this.vz = -this.vz * 0.4;
      this.speed *= 0.55;
    }
    if (this.z < -Arena.L/2 + r && !inGoalSlot) {
      this.z = -Arena.L/2 + r;
      if (this.vz < 0) this.vz = -this.vz * 0.4;
      this.speed *= 0.55;
    }
    // 天井
    if (this.y > Arena.H - r) {
      this.y = Arena.H - r;
      if (this.vy > 0) this.vy = -this.vy * 0.4;
    }
    // コーナー(斜め壁)
    Arena.resolveCornerCollision(this, r, 0.45);
  }

  // 受信状態の適用
  applyRemoteState(state) {
    this.x = Utils.lerp(this.x, state.x, 0.4);
    this.y = Utils.lerp(this.y, state.y, 0.4);
    this.z = Utils.lerp(this.z, state.z, 0.4);
    let da = state.angle - this.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.angle += da * 0.4;
    this.pitch = state.pitch || 0;
    this.roll = state.roll || 0;
    this.vx = state.vx || 0;
    this.vy = state.vy || 0;
    this.vz = state.vz || 0;
    this.speed = state.speed || 0;
    if (state.boost !== undefined) this.boost = state.boost;
    this.onGround = !!state.onGround;
    for (const f of this.flames) f.visible = !!state.boosting;
    for (const f of this.flamesInner) f.visible = !!state.boosting;
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

  // ボール衝突の見た目フィードバック
  bumpFromBall(power) {
    const k = Math.min(1, power / 30);
    this.pitch += (Math.random() - 0.5) * 0.4 * k;
    this.roll  += (Math.random() - 0.5) * 0.4 * k;
  }
}

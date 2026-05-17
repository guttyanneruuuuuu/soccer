// ============= 車 (ロケットリーグ風物理) =============
// スマホ操作前提:
//   - アクセル: ACCELボタン (右下) ホールド
//   - ブレーキ/バック: ジャイロ後傾
//   - ブースト: BOOSTボタン (右中) ホールド
//   - ステア: ジャイロ左右
//   - 空中ピッチ: ジャイロ前後傾
//   - 空中ロール: AIR ROLLボタン押している間、ステアをロール回転に切替
//   - ジャンプ/フリップ: JUMPボタン
const CarPhys = {
  // サイズ (ボディスケール 3.4 × ベース寸法 ≒ 全長 ~12m / 半径 4.8m)
  RADIUS: 4.8,
  HEIGHT: 3.4,

  // 速度パラメタ
  MAX_SPEED: 78,            // 通常上限
  MAX_SPEED_BOOST: 105,     // ブースト最大
  SUPERSONIC_SPEED: 82,     // この速度を超えるとスーパーソニック演出
  ACCEL: 70,                // 加速度
  REVERSE_ACCEL: 30,        // バックの加速
  BRAKE: 88,                // ブレーキ強度
  FRICTION: 3.6,            // 何もしない時の減速
  AIR_FRICTION: 0.30,       // 空中の空気抵抗
  STEER_SPEED: 3.35,        // ハンドル切る速度
  STEER_AT_SPEED: 0.55,     // 高速時のステア効きを下げて挙動安定
  LATERAL_GRIP: 11.0,
  STEER_LOW_SPEED_BONUS: 1.45,  // 低速時の旋回ボーナス

  // 空中
  GRAVITY: 42,
  JUMP_VEL: 32,             // 初段ジャンプ
  DOUBLE_JUMP_VEL: 28,      // 2段目
  AIR_PITCH_SPEED: 5.4,
  AIR_ROLL_SPEED: 5.6,      // ロール速度 (新規)
  AIR_YAW_SPEED: 4.4,       // 空中ヨー (通常ステア時)

  // ブースト
  BOOST_FORCE: 118,         // ブースト推力 (++)
  BOOST_PER_SEC: 38,        // 燃料消費
  BOOST_MAX: 100,           // 最大100に統一 (HUD互換)
  BOOST_INITIAL: 50,
  BOOST_MIN_HOLD: 0.10,     // 燃料0でも最低0.1秒は炎の見た目を維持
  // 壁
  WALL_BOUNCE: 0.18,
  WALL_SPEED_KEEP: 0.9,
  WALL_CLIMB_MIN_IMPACT: 6,
  WALL_CLIMB_VEL: 8.2,
  // 二段ジャンプ時の追加推進
  FLIP_FORWARD_VEL: 14,     // フリップ前進加速 (10 → 14)
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
    this.angle = opts.angle || 0;    // ヨー
    this.pitch = 0;                  // ピッチ (機首上下)
    this.roll = 0;                   // ロール (左右回転)

    this.speed = 0;
    this.onGround = true;

    // ジャンプ
    this.jumpsUsed = 0;
    this.airTime = 0;
    this._jumpEdgeTimer = 0;  // ジャンプ後の入力エッジ判定保護

    // ブースト
    this.boost = CarPhys.BOOST_INITIAL;
    this.boostMax = CarPhys.BOOST_MAX;
    this._lastBoostTime = 0;

    // ボール衝突クールダウン
    this.ballHitCooldown = 0;

    // ゴール後の入力ロック
    this.lockTimer = 0;

    // デモリッション後リスポーン
    this.respawnTimer = 0;
    this._spawnX = opts.x || 0;
    this._spawnZ = opts.z || 0;
    this._spawnAngle = opts.angle || 0;

    // 状態フラグ (game.jsから観測)
    this.isSupersonic = false;
    this.isFlipping = false;
    this._flipDir = 0;

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

    // ===== スーパーソニックトレイル (ローカル車のみ) =====
    if (this.isLocal) {
      const ssMat = new THREE.MeshBasicMaterial({
        color: 0xffeb3b, transparent: true, opacity: 0,
      });
      const ssGeo = new THREE.ConeGeometry(0.85 * S, 3.2 * S, 8);
      const ssTrail = new THREE.Mesh(ssGeo, ssMat);
      ssTrail.position.set(0, -0.2 * S, -2.6 * S);
      ssTrail.rotation.x = -Math.PI / 2;
      group.add(ssTrail);
      this._ssTrail = ssTrail;
    }

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
        this.boost = Math.max(this.boost, CarPhys.BOOST_INITIAL + 10);
        this.mesh.visible = true;
        this.onGround = true;
        this.jumpsUsed = 0;
      }
      this.syncMesh();
      return;
    }

    if (this._jumpEdgeTimer > 0) this._jumpEdgeTimer -= dt;

    // ===== 操舵 =====
    if (input) {
      const speedRatio = Math.min(1, Math.abs(this.speed) / CarPhys.MAX_SPEED);
      const steerEffect = (1 - speedRatio * (1 - CarPhys.STEER_AT_SPEED));
      if (this.onGround) {
        // 地上はヨー (ハンドル) — 後進中は逆向きに効くと自然
        const dir = this.speed >= 0 ? 1 : -1;
        // 低速で旋回しやすく
        const lowSpeedBoost = 1 + (1 - speedRatio) * (CarPhys.STEER_LOW_SPEED_BONUS - 1);
        this.angle += input.steer * CarPhys.STEER_SPEED * steerEffect * lowSpeedBoost * dir * dt;
        // 地上のロール演出
        const targetRoll = -input.steer * Math.min(0.22, Math.abs(this.speed) / CarPhys.MAX_SPEED * 0.28);
        this.roll = Utils.lerp(this.roll, targetRoll, dt * 6);
      } else {
        // 空中: AIR ROLLボタン押下中は steer をロールとして使う
        // それ以外は steer をヨー(横回転)、pitchを縦回転として使う
        const airRoll = !!input.airRoll;
        if (airRoll) {
          // ロール (左右にゴロンと回る)
          this.roll += input.steer * CarPhys.AIR_ROLL_SPEED * dt;
        } else {
          // 通常: ヨー (左右回頭)
          this.angle += input.steer * CarPhys.AIR_YAW_SPEED * dt;
          // ロールは見た目程度に
          const targetRoll = -input.steer * 0.4;
          this.roll = Utils.lerp(this.roll, targetRoll, dt * 4);
        }
        // ピッチ (機首上下) - 端末ピッチを入力に使う
        const airPitchInput = (typeof Input !== 'undefined') ? (Input.pitch || 0) : 0;
        const pitchSteer = airPitchInput + (input.brake ? 0.6 : 0);
        this.pitch += pitchSteer * CarPhys.AIR_PITCH_SPEED * dt;
        // ピッチを正規化
        if (this.pitch > Math.PI) this.pitch -= Math.PI * 2;
        if (this.pitch < -Math.PI) this.pitch += Math.PI * 2;
        // ロールも正規化
        if (this.roll > Math.PI) this.roll -= Math.PI * 2;
        if (this.roll < -Math.PI) this.roll += Math.PI * 2;
      }
    }

    // ===== アクセル + ブレーキ =====
    if (input && this.onGround) {
      if (input.brake) {
        if (this.speed > 0) this.speed -= CarPhys.BRAKE * dt;
        else this.speed -= CarPhys.REVERSE_ACCEL * dt;
      } else if (input.accel) {
        this.speed += CarPhys.ACCEL * dt;
      } else {
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
      this._lastBoostTime = CarPhys.BOOST_MIN_HOLD; // 燃料切れ時もしばらく炎を維持
      // 前進方向(車の向き)に推力
      const fx = Math.sin(this.angle), fz = Math.cos(this.angle);
      if (this.onGround) {
        this.speed += CarPhys.BOOST_FORCE * 0.62 * dt;
      } else {
        const cp = Math.cos(this.pitch);
        const sp_ = Math.sin(this.pitch);
        this.vx += fx * cp * CarPhys.BOOST_FORCE * dt;
        this.vy += -sp_  * CarPhys.BOOST_FORCE * dt;
        this.vz += fz * cp * CarPhys.BOOST_FORCE * dt;
      }
    } else if (this._lastBoostTime > 0) {
      this._lastBoostTime -= dt;
      boosting = this._lastBoostTime > 0;
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

    // ===== ジャンプ =====
    const isSpring = this.activePower === 'spring';
    const jumpMult = isSpring ? 1.8 : 1;
    const maxJumps = isSpring ? 3 : 2;
    if (input) {
      if (this.onGround && input.jump) {
        this.vy = CarPhys.JUMP_VEL * jumpMult;
        this.onGround = false;
        this.jumpsUsed = 1;
        this.airTime = 0;
        this._jumpEdgeTimer = 0.08;
      } else if (!this.onGround && this.jumpsUsed < maxJumps && input.jump && this._jumpEdgeTimer <= 0) {
        // ダブルジャンプ: フリップ風
        this.vy = CarPhys.DOUBLE_JUMP_VEL * jumpMult;
        this.jumpsUsed++;
        this.isFlipping = true;
        // フリップ方向: ステア入力で前/横方向に切替
        // steer が大きいなら横フリップ、ほぼ0なら前フリップ
        const lateral = Math.abs(input.steer);
        let fx, fz;
        if (lateral > 0.45) {
          // 横フリップ (左右)
          const side = input.steer < 0 ? 1 : -1; // ステア左ならX-側へ
          fx = Math.cos(this.angle) * side;
          fz = -Math.sin(this.angle) * side;
          this.roll += Math.PI * 0.6 * side;
        } else if (input.brake) {
          // 後ろフリップ (バックフリップ)
          fx = -Math.sin(this.angle);
          fz = -Math.cos(this.angle);
          this.pitch -= Math.PI * 0.55;
        } else {
          // 前フリップ
          fx = Math.sin(this.angle);
          fz = Math.cos(this.angle);
          this.pitch += Math.PI * 0.65;
        }
        const fv = CarPhys.FLIP_FORWARD_VEL;
        this.vx += fx * fv;
        this.vz += fz * fv;
        this._jumpEdgeTimer = 0.08;
        this._flipDir = input.brake ? -1 : 1;
        // フリップ終了タイマー (アニメ判定用)
        setTimeout(() => { this.isFlipping = false; }, 350);
      }
    }

    // ===== 地上速度をベクトル化 =====
    if (this.onGround) {
      this.vx = Math.sin(this.angle) * this.speed;
      this.vz = Math.cos(this.angle) * this.speed;
      this.vy = 0;
      this.y = CarPhys.HEIGHT;
    } else {
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
        // ハードランディング判定
        const upsideDown = Math.abs(this.pitch) > Math.PI / 2 + 0.4 || Math.abs(this.roll) > Math.PI / 2 + 0.4;
        if (upsideDown) {
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

    // ===== スーパーソニック判定 =====
    const curSpeed = Math.sqrt(this.vx*this.vx + this.vy*this.vy + this.vz*this.vz);
    // ヒステリシス (一度発動したら速度がやや下がっても維持)
    if (this.isSupersonic) {
      this.isSupersonic = curSpeed > CarPhys.SUPERSONIC_SPEED * 0.92;
    } else {
      this.isSupersonic = curSpeed > CarPhys.SUPERSONIC_SPEED;
    }
    // スーパーソニックトレイル表示
    if (this._ssTrail) {
      const targetOpacity = this.isSupersonic ? 0.85 : 0;
      this._ssTrail.material.opacity = Utils.lerp(this._ssTrail.material.opacity, targetOpacity, 0.15);
    }

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
    const climbFromWall = (impactSpeed) => {
      if (!this.onGround) return;
      if (impactSpeed < CarPhys.WALL_CLIMB_MIN_IMPACT) return;
      if (this.y >= Arena.H - r - 0.5) return;
      const lift = CarPhys.WALL_CLIMB_VEL + Math.min(3.2, impactSpeed * 0.14);
      this.vy = Math.max(this.vy, lift);
      this.y = Math.max(this.y, CarPhys.HEIGHT + 0.06);
      this.onGround = false;
    };

    // 側壁 X
    if (this.x > Arena.W/2 - r) {
      this.x = Arena.W/2 - r;
      if (this.vx > 0) {
        const impact = this.vx;
        this.vx = -this.vx * CarPhys.WALL_BOUNCE;
        this.speed *= CarPhys.WALL_SPEED_KEEP;
        climbFromWall(impact);
      }
    }
    if (this.x < -Arena.W/2 + r) {
      this.x = -Arena.W/2 + r;
      if (this.vx < 0) {
        const impact = -this.vx;
        this.vx = -this.vx * CarPhys.WALL_BOUNCE;
        this.speed *= CarPhys.WALL_SPEED_KEEP;
        climbFromWall(impact);
      }
    }
    // 短辺 Z (ゴール口除外)
    const inGoalSlot = Arena.isInGoalSlot(this.x, this.y, r);
    if (this.z > Arena.L/2 - r && !inGoalSlot) {
      this.z = Arena.L/2 - r;
      if (this.vz > 0) {
        const impact = this.vz;
        this.vz = -this.vz * CarPhys.WALL_BOUNCE;
        this.speed *= CarPhys.WALL_SPEED_KEEP;
        climbFromWall(impact);
      }
    }
    if (this.z < -Arena.L/2 + r && !inGoalSlot) {
      this.z = -Arena.L/2 + r;
      if (this.vz < 0) {
        const impact = -this.vz;
        this.vz = -this.vz * CarPhys.WALL_BOUNCE;
        this.speed *= CarPhys.WALL_SPEED_KEEP;
        climbFromWall(impact);
      }
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

  // ボール衝突の見た目フィードバック + 軽い反作用
  bumpFromBall(power) {
    const k = Math.min(1, power / 30);
    this.pitch += (Math.random() - 0.5) * 0.35 * k;
    this.roll  += (Math.random() - 0.5) * 0.35 * k;
    // 重い当たりは車も少し押し返される (打感UP)
    // game.js から呼ばれる位置で衝突法線が分かるが、ここでは見た目だけ
  }
}

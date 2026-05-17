// ============= ゲームメイン (シーン/カメラ/ループ/ホストシム) =============
const Game = {
  scene: null,
  camera: null,
  renderer: null,
  canvas: null,

  cars: new Map(),       // id -> Car
  localCar: null,
  ball: null,

  remoteInputs: new Map(), // ホスト用: clientId -> 最新input

  scoreBlue: 0,
  scoreOrange: 0,
  matchDuration: 300,
  matchTime: 0,
  matchStarted: false,
  matchEnded: false,
  goalAnimTimer: 0,
  kickoffCountdown: 0,
  _lastBoostPadCheck: 0,

  // ホストシム
  matchSize: 3,
  myInfo: { id: 'me', name: 'Player', color: '#E53935', team: 'blue' },

  _stateAccum: 0,
  _stateInterval: 1 / 20,

  lastFrameTime: 0,
  running: false,
  paused: false,

  // パーティクル (ボールヒット煙)
  _particles: [],

  init() {
    this.canvas = document.getElementById('game-canvas');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x4a90c8);
    scene.fog = new THREE.Fog(0x4a90c8, 120, 320);
    this.scene = scene;

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.1, 800);
    this.camera.position.set(0, 30, -80);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // ライト
    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
    sun.position.set(50, 110, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -100;
    sun.shadow.camera.right = 100;
    sun.shadow.camera.top = 110;
    sun.shadow.camera.bottom = -110;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 300;
    scene.add(sun);

    // 補助光 (チームカラー風)
    const hemi = new THREE.HemisphereLight(0x88c0ff, 0x224488, 0.35);
    scene.add(hemi);

    Arena.build(scene);
    this.ball = new Ball(scene);

    window.addEventListener('resize', () => this._onResize());
  },

  _onResize() {
    if (!this.renderer || !this.camera) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  },

  startMatch(opts) {
    const players = opts.players || [{ ...this.myInfo, id: 'solo', isLocal: true }];
    // クリーンアップ
    for (const c of this.cars.values()) this.scene.remove(c.mesh);
    this.cars.clear();
    this.remoteInputs.clear();
    this.scoreBlue = 0;
    this.scoreOrange = 0;
    this.matchTime = 0;
    this.matchStarted = true;
    this.matchEnded = false;
    this.goalAnimTimer = 0;
    this.matchDuration = opts.duration || 300;
    this.kickoffCountdown = 3.0;

    // スポーン
    const blueList = players.filter(p => p.team === 'blue');
    const orgList  = players.filter(p => p.team === 'orange');
    const spawn = (list, zSign) => {
      list.forEach((p, i) => {
        const xOff = (i - (list.length - 1) / 2) * 10;
        const isLocal = (p.id === this.myInfo.id) || p.isLocal;
        const car = new Car({
          id: p.id, name: p.name, color: p.color, team: p.team,
          isLocal, isRemote: !isLocal,
          x: xOff, z: zSign * (Arena.L / 2 - 20),
          angle: zSign < 0 ? 0 : Math.PI,
        });
        this.cars.set(p.id, car);
        this.scene.add(car.mesh);
        if (isLocal) this.localCar = car;
      });
    };
    spawn(blueList, -1);
    spawn(orgList, 1);

    this.ball.reset();

    document.getElementById('hud-score-blue').textContent = '0';
    document.getElementById('hud-score-orange').textContent = '0';
    document.getElementById('hud-time').textContent = Utils.formatTime(this.matchDuration * 1000);
    document.getElementById('finish-overlay').classList.remove('show');

    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    requestAnimationFrame(this._frame.bind(this));

    this._showCountdown();
  },

  _showCountdown() {
    const el = document.getElementById('countdown');
    if (!el) return;
    let n = 3;
    el.textContent = n;
    el.classList.add('show');
    SFX.countBeep();
    const tick = () => {
      n--;
      if (n > 0) {
        el.textContent = n;
        el.classList.remove('show');
        // reflow
        void el.offsetWidth;
        el.classList.add('show');
        SFX.countBeep();
        setTimeout(tick, 1000);
      } else if (n === 0) {
        el.textContent = 'GO!';
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
        SFX.countBeep(false);
        setTimeout(() => el.classList.remove('show'), 800);
      }
    };
    setTimeout(tick, 1000);
  },

  endMatch(winner) {
    this.matchEnded = true;
    this.running = false;
    const titleEl = document.getElementById('finish-title');
    if (winner === 'blue') titleEl.textContent = '🔵 BLUE WIN!';
    else if (winner === 'orange') titleEl.textContent = '🟠 ORANGE WIN!';
    else titleEl.textContent = '🤝 DRAW';
    document.getElementById('finish-score').textContent = `${this.scoreBlue} - ${this.scoreOrange}`;
    document.getElementById('finish-overlay').classList.add('show');
    SFX.goal();
  },

  _frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    if (!this.paused) this.update(dt);
    this.render();
    requestAnimationFrame(this._frame.bind(this));
  },

  update(dt) {
    Input.update(dt);

    // キックオフ前カウントダウン中は車もボールも動かさない
    const kickoffActive = this.kickoffCountdown > 0;
    if (kickoffActive) {
      this.kickoffCountdown -= dt;
    }

    // ゴール演出中
    if (this.goalAnimTimer > 0) {
      this.goalAnimTimer -= dt;
      if (this.goalAnimTimer <= 0) {
        this._kickoffReset();
      }
    }

    // タイマー
    if (this.matchStarted && !this.matchEnded && this.goalAnimTimer <= 0 && !kickoffActive) {
      this.matchTime += dt;
      const remain = Math.max(0, this.matchDuration - this.matchTime);
      document.getElementById('hud-time').textContent = Utils.formatTime(remain * 1000);
      if (remain <= 0) {
        let winner = 'draw';
        if (this.scoreBlue > this.scoreOrange) winner = 'blue';
        else if (this.scoreOrange > this.scoreBlue) winner = 'orange';
        if (Net.isHost || !Net.peer) {
          if (Net.isHost) Net.broadcastEnd({ winner, blue: this.scoreBlue, orange: this.scoreOrange });
          this.endMatch(winner);
        }
      }
    }

    // ===== ローカル車の入力組み立て =====
    let inputState = null;
    if (this.localCar && !kickoffActive && this.goalAnimTimer <= 0) {
      inputState = {
        steer: Input.steer,
        accel: true,        // 自動 ON
        brake: Input.brake,
        boost: Input.boost,
        jump: Input.consumeJump(),
      };
      this._lastLocalInput = inputState;
      this.localCar.update(dt, inputState);
      // ジャンプSFX
      if (inputState.jump) {
        if (this.localCar.jumpsUsed === 1) SFX.jump();
        else SFX.doubleJump();
      }
    } else if (this.localCar) {
      // カウントダウン中はメッシュだけ更新 (空入力)
      this.localCar.update(dt, null);
    }

    // ===== オンライン処理 =====
    if (Net.peer && Net.isHost) {
      // ホスト: 他クライアントの車を彼らの入力で
      for (const [id, car] of this.cars) {
        if (car === this.localCar) continue;
        if (kickoffActive || this.goalAnimTimer > 0) {
          car.update(dt, null);
          continue;
        }
        let inp = this.remoteInputs.get(id);
        if (!inp) inp = { steer: 0, accel: true, brake: false, boost: false, jump: false };
        car.update(dt, inp);
        if (inp.jump) inp.jump = false;
      }
      // ボール物理
      if (!kickoffActive && this.goalAnimTimer <= 0) {
        this.ball.update(dt);
        // 衝突
        for (const car of this.cars.values()) {
          if (car.ballHitCooldown > 0) continue;
          const hitSp = this.ball.collideWithCar(car);
          if (hitSp > 0) this._onBallHit(car, hitSp);
        }
        // 車同士の弱い衝突
        this._resolveCarVsCar();

        // ゴール判定
        const g = this.ball.checkGoal();
        if (g === 1) { this.scoreBlue += 1; this._onGoal('blue'); }
        else if (g === -1) { this.scoreOrange += 1; this._onGoal('orange'); }
      }

      // 状態配信
      this._stateAccum += dt;
      if (this._stateAccum >= this._stateInterval) {
        this._stateAccum = 0;
        const carStates = [];
        for (const car of this.cars.values()) {
          let boostingFlag;
          if (car === this.localCar) {
            boostingFlag = !!(inputState && inputState.boost && car.boost > 0);
          } else {
            const inp = this.remoteInputs.get(car.id);
            boostingFlag = !!(inp && inp.boost && car.boost > 0);
          }
          carStates.push(car.getNetState(boostingFlag));
        }
        Net.broadcastState({
          cars: carStates,
          ball: this.ball.getNetState(),
          scoreBlue: this.scoreBlue,
          scoreOrange: this.scoreOrange,
          matchTime: this.matchTime,
          goalAnim: this.goalAnimTimer,
          kickoff: this.kickoffCountdown,
        });
      }
    } else if (Net.peer && !Net.isHost) {
      // クライアント: 入力をホストへ送信
      Net.sendToHost({ type: 'input', input: {
        steer: Input.steer,
        accel: true,
        brake: Input.brake,
        boost: Input.boost,
        jump: this._lastLocalInput ? this._lastLocalInput.jump : false,
      }});
    } else {
      // ソロ: 自分でボール・Bot
      if (!kickoffActive && this.goalAnimTimer <= 0) {
        this.ball.update(dt);
        for (const car of this.cars.values()) {
          if (car !== this.localCar) {
            this._botUpdate(car, dt);
          }
          if (car.ballHitCooldown > 0) continue;
          const hitSp = this.ball.collideWithCar(car);
          if (hitSp > 0) this._onBallHit(car, hitSp);
        }
        this._resolveCarVsCar();
        const g = this.ball.checkGoal();
        if (g === 1) { this.scoreBlue++; this._onGoal('blue'); }
        else if (g === -1) { this.scoreOrange++; this._onGoal('orange'); }
      } else if (kickoffActive) {
        for (const car of this.cars.values()) {
          if (car !== this.localCar) car.update(dt, null);
        }
      }
    }

    // カメラ
    if (this.localCar) this._updateCamera(dt);

    // HUD
    this._updateHUD();

    // パッド演出
    Arena.updatePads(dt, performance.now());

    // パッド取得SFX (差分検知)
    this._checkBoostPadSFX();
  },

  _checkBoostPadSFX() {
    // 状態変化検出は consumePad 内で行う方が良いが簡易: 直近で取れたかを音で
    // (game.js のローカル車をパッド踏んだ時に SFX を鳴らすため、car.js 内では呼べないので)
    if (!this.localCar) return;
    const now = performance.now();
    if (now - this._lastBoostPadCheck < 80) return;
    this._lastBoostPadCheck = now;
    // 直近で active=false になったパッドのうち、ローカル車の近くにあるものを推測
    for (const p of Arena.boostPads) {
      if (p.active) continue;
      const dx = this.localCar.x - p.x;
      const dz = this.localCar.z - p.z;
      const r2 = (p.big ? 3.6 : 2.0);
      if (dx * dx + dz * dz < r2 * r2 + 1 && !p._sfxPlayed) {
        SFX.boostPad(p.big);
        p._sfxPlayed = true;
        // パッド復活時にリセット
        setTimeout(() => { p._sfxPlayed = false; }, (p.big ? 10000 : 4000));
        break;
      }
    }
  },

  // 車同士の押し合い (極めて軽い衝突解決)
  _resolveCarVsCar() {
    const list = Array.from(this.cars.values());
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const minD = CarPhys.RADIUS * 2;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2) || 0.0001;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        const overlap = (minD - d) * 0.5;
        a.x -= nx * overlap; a.y -= ny * overlap; a.z -= nz * overlap;
        b.x += nx * overlap; b.y += ny * overlap; b.z += nz * overlap;
        // 速度反発 (弱め)
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy, rvz = b.vz - a.vz;
        const dot = rvx*nx + rvy*ny + rvz*nz;
        if (dot < 0) {
          const j = -(1 + 0.2) * dot * 0.5;
          a.vx -= nx * j; a.vy -= ny * j; a.vz -= nz * j;
          b.vx += nx * j; b.vy += ny * j; b.vz += nz * j;
          // 強衝突なら SFX
          if (Math.abs(dot) > 12) {
            SFX.thud(Math.min(1, Math.abs(dot) / 30));
          }
        }
      }
    }
  },

  _onBallHit(car, hitSpeed) {
    if (hitSpeed > 38) SFX.ballSmash(1);
    else SFX.ballHit(Utils.clamp(hitSpeed / 40, 0.2, 1));
  },

  // クライアント: ホスト状態の適用
  applyAuthState(state) {
    if (Net.isHost) return;
    if (state.cars) {
      for (const cs of state.cars) {
        const car = this.cars.get(cs.id);
        if (!car) continue;
        if (car === this.localCar) {
          // ローカル車は軽く補正のみ
          car.x = Utils.lerp(car.x, cs.x, 0.15);
          car.y = Utils.lerp(car.y, cs.y, 0.15);
          car.z = Utils.lerp(car.z, cs.z, 0.15);
          car.boost = cs.boost;
          car.syncMesh();
        } else {
          car.applyRemoteState(cs);
        }
      }
    }
    if (state.ball) this.ball.applyRemoteState(state.ball);
    if (typeof state.scoreBlue === 'number') {
      this.scoreBlue = state.scoreBlue;
      document.getElementById('hud-score-blue').textContent = String(state.scoreBlue);
    }
    if (typeof state.scoreOrange === 'number') {
      this.scoreOrange = state.scoreOrange;
      document.getElementById('hud-score-orange').textContent = String(state.scoreOrange);
    }
    if (typeof state.matchTime === 'number') {
      this.matchTime = state.matchTime;
      const remain = Math.max(0, this.matchDuration - state.matchTime);
      document.getElementById('hud-time').textContent = Utils.formatTime(remain * 1000);
    }
    if (typeof state.goalAnim === 'number') this.goalAnimTimer = state.goalAnim;
    if (typeof state.kickoff === 'number') this.kickoffCountdown = state.kickoff;
  },

  _onGoal(team) {
    this.goalAnimTimer = 3.0;
    SFX.goal();
    const banner = document.getElementById('goal-banner');
    if (banner) {
      banner.textContent = team === 'blue' ? '🔵 GOAL! BLUE!' : '🟠 GOAL! ORANGE!';
      banner.style.color = team === 'blue' ? '#29b6f6' : '#ff7043';
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 2500);
    }
    document.getElementById('hud-score-blue').textContent = String(this.scoreBlue);
    document.getElementById('hud-score-orange').textContent = String(this.scoreOrange);
    if (Net.isHost) {
      Net.broadcastGoal({ team, blue: this.scoreBlue, orange: this.scoreOrange });
    }
  },

  applyGoal(info) {
    if (Net.isHost) return;
    this.scoreBlue = info.blue;
    this.scoreOrange = info.orange;
    this._onGoal(info.team);
  },

  applyEnd(info) {
    if (Net.isHost) return;
    this.scoreBlue = info.blue;
    this.scoreOrange = info.orange;
    this.endMatch(info.winner);
  },

  _kickoffReset() {
    this.ball.reset();
    const blueList = Array.from(this.cars.values()).filter(c => c.team === 'blue');
    const orgList = Array.from(this.cars.values()).filter(c => c.team === 'orange');
    const resetTeam = (list, zSign) => {
      list.forEach((c, i) => {
        const xOff = (i - (list.length - 1) / 2) * 10;
        c.x = xOff;
        c.z = zSign * (Arena.L / 2 - 20);
        c.y = CarPhys.HEIGHT;
        c.vx = c.vy = c.vz = 0;
        c.speed = 0;
        c.angle = zSign < 0 ? 0 : Math.PI;
        c.pitch = 0; c.roll = 0;
        c.onGround = true;
        c.jumpsUsed = 0;
        c.syncMesh();
      });
    };
    resetTeam(blueList, -1);
    resetTeam(orgList, 1);
    this.kickoffCountdown = 1.5; // ゴール後の小カウントダウン
  },

  _updateCamera(dt) {
    const car = this.localCar;
    // ロケットリーグ風: ボール方向を見つつ車の後ろから
    // 基本は車後方上方からの追従
    const back = 22;
    const up = 9;
    // 速度に応じてカメラ後退距離を伸ばす
    const sp = Math.abs(car.speed);
    const dynBack = back + Math.min(8, sp * 0.18);
    const camX = car.x - Math.sin(car.angle) * dynBack;
    const camZ = car.z - Math.cos(car.angle) * dynBack;
    const camY = car.y + up + Math.min(4, sp * 0.1);

    // 速いほどスムージング弱め
    const alpha = Utils.clamp(0.14 + sp * 0.003, 0.14, 0.30);
    this.camera.position.x = Utils.lerp(this.camera.position.x, camX, alpha);
    this.camera.position.y = Utils.lerp(this.camera.position.y, camY, alpha);
    this.camera.position.z = Utils.lerp(this.camera.position.z, camZ, alpha);

    // 見る先: ボール方向に少しブレンド (空中プレイ時に役立つ)
    const lookXTarget = car.x + Math.sin(car.angle) * 6;
    const lookZTarget = car.z + Math.cos(car.angle) * 6;
    // ボールが近いとボールを少し見る
    const dxb = this.ball.x - car.x;
    const dzb = this.ball.z - car.z;
    const distBall = Math.sqrt(dxb*dxb + dzb*dzb);
    let lookX = lookXTarget, lookY = car.y + 2, lookZ = lookZTarget;
    if (distBall < 30 && this.ball.y > 6) {
      const w = Utils.clamp(1 - distBall / 30, 0, 0.5);
      lookX = lookXTarget * (1 - w) + this.ball.x * w;
      lookY = (car.y + 2) * (1 - w) + this.ball.y * w * 0.7;
      lookZ = lookZTarget * (1 - w) + this.ball.z * w;
    }
    this.camera.lookAt(lookX, lookY, lookZ);
  },

  _updateHUD() {
    if (!this.localCar) return;
    const car = this.localCar;
    const boostPct = Math.round(car.boost);
    // 円形ゲージ
    const ring = document.getElementById('boost-ring-fill');
    if (ring) {
      const C = 2 * Math.PI * 34; // 213.6
      const offset = C * (1 - boostPct / 100);
      ring.setAttribute('stroke-dashoffset', offset.toFixed(1));
      // 色変化 (低 boostは赤系)
      let color = '#ff8800';
      if (boostPct < 30) color = '#ef5350';
      else if (boostPct > 70) color = '#ffeb3b';
      ring.setAttribute('stroke', color);
    }
    const bv = document.getElementById('boost-val');
    if (bv) bv.textContent = boostPct;

    // スピード (km/h)
    const sv = document.getElementById('hud-speed');
    if (sv) {
      const sp = Math.round(Math.sqrt(car.vx**2 + car.vy**2 + car.vz**2) * 3.6);
      sv.textContent = sp;
    }

    // ブレーキインジケーター
    const bi = document.getElementById('brake-indicator');
    if (bi) bi.classList.toggle('show', !!Input.brake);

    // ジャイロインジケーター (左右の傾きを点で表示)
    const arrow = document.getElementById('gyro-arrow');
    if (arrow) {
      const pct = Utils.clamp(Input.steer, -1, 1);
      const x = 50 + pct * 45;
      arrow.style.left = x + '%';
    }
  },

  render() {
    this.renderer.render(this.scene, this.camera);
  },

  // ====== ソロ用 簡易Bot AI ======
  _botUpdate(car, dt) {
    // 役割: ボールが自陣に近いと守備、敵陣なら攻め
    const ownGoalZ = car.team === 'blue' ? -Arena.L/2 : Arena.L/2;
    const enemyGoalZ = -ownGoalZ;

    // 攻撃: ボールを敵ゴール方向に押す
    const aimZBias = (enemyGoalZ - this.ball.z) * 0.18;
    const tx = this.ball.x + (this.ball.x === 0 ? 0 : 0);
    let tz = this.ball.z + aimZBias;
    // ボールの後ろに回り込む
    const behindZ = this.ball.z + (this.ball.z - enemyGoalZ > 0 ? 4 : -4);
    // 距離が遠いとき後ろに回り込み目標を切替
    const distToBall = Math.hypot(this.ball.x - car.x, this.ball.z - car.z);
    const onSameSide = (enemyGoalZ > 0)
      ? (car.z < this.ball.z)
      : (car.z > this.ball.z);
    let targetX = tx, targetZ = tz;
    if (!onSameSide && distToBall > 8) {
      // 回り込み (ボール越し)
      targetX = this.ball.x;
      targetZ = this.ball.z + (enemyGoalZ > 0 ? -8 : 8);
    }

    const dx = targetX - car.x;
    const dz = targetZ - car.z;
    const targetAngle = Math.atan2(dx, dz);
    let da = targetAngle - car.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steer = Utils.clamp(da * 2.0, -1, 1);
    const dist = Math.sqrt(dx*dx + dz*dz);
    const inp = {
      steer,
      accel: true,
      brake: false,
      // ボールがすぐ近くで車が逆向きの時はブレーキ
      boost: dist > 18 && car.boost > 15 && Math.abs(da) < 0.5,
      jump: false,
    };
    // 空中ボールを攻める
    if (this.ball.y > 7 && distToBall < 12 && car.onGround && Math.random() < 0.15) {
      inp.jump = true;
    }
    // ボールがゴールに近い時の守備
    const ballDistOwn = Math.abs(this.ball.z - ownGoalZ);
    if (ballDistOwn < 25 && Math.random() < 0.05) {
      // 自陣に戻る
      targetX = 0;
      targetZ = ownGoalZ + (ownGoalZ > 0 ? -8 : 8);
    }
    car.update(dt, inp);
  },
};

// ホスト/クライアントネット連携
if (typeof Net !== 'undefined') {
  Net.on('clientInput', (id, input) => {
    Game.remoteInputs.set(id, input);
  });
  Net.on('state', (st) => Game.applyAuthState(st));
  Net.on('goal', (info) => Game.applyGoal(info));
  Net.on('gameEnd', (info) => Game.applyEnd(info));
}

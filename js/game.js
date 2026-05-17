// ============= ゲームメイン (シーン/カメラ/ループ/ホストシム) =============
const Game = {
  scene: null,
  camera: null,
  renderer: null,
  canvas: null,

  cars: new Map(),       // id -> Car
  localCar: null,        // 自分の車
  ball: null,

  remoteInputs: new Map(), // ホストの場合: clientId -> 最新input

  scoreBlue: 0,
  scoreOrange: 0,
  matchDuration: 300,    // 5分
  matchTime: 0,
  matchStarted: false,
  matchEnded: false,
  goalAnimTimer: 0,
  resetCountdown: 0,

  // 設定: チーム / マッチタイプ
  matchSize: 3,          // 3v3デフォルト
  myInfo: { name: 'Player', color: '#E53935', team: 'blue' },

  // ホスト側 同期周期
  _stateAccum: 0,
  _stateInterval: 1 / 20,    // 20Hz

  lastFrameTime: 0,
  running: false,

  init() {
    this.canvas = document.getElementById('game-canvas');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 80, 220);
    this.scene = scene;

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 600);
    this.camera.position.set(0, 25, -60);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;

    // ライト
    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(amb);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(40, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    scene.add(sun);

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

  // 開始: プレイヤーリストから車を生成
  startMatch(opts) {
    const players = opts.players || [{ ...this.myInfo, id: 'solo', isLocal: true }];
    // 既存のクリーンアップ
    for (const c of this.cars.values()) this.scene.remove(c.mesh);
    this.cars.clear();
    this.remoteInputs.clear();
    this.scoreBlue = 0;
    this.scoreOrange = 0;
    this.matchTime = 0;
    this.matchStarted = true;
    this.matchEnded = false;
    this.goalAnimTimer = 0;
    this.resetCountdown = 0;
    this.matchDuration = opts.duration || 300;

    // チーム別にスポーン位置決定
    const blueList = players.filter(p => p.team === 'blue');
    const orgList  = players.filter(p => p.team === 'orange');
    const spawn = (list, zSign) => {
      list.forEach((p, i) => {
        const xOff = (i - (list.length - 1) / 2) * 8;
        const isLocal = (p.id === this.myInfo.id) || p.isLocal;
        const car = new Car({
          id: p.id, name: p.name, color: p.color, team: p.team,
          isLocal, isRemote: !isLocal,
          x: xOff, z: zSign * (Arena.L / 2 - 15),
          angle: zSign < 0 ? 0 : Math.PI,  // ゴールに向く
        });
        this.cars.set(p.id, car);
        this.scene.add(car.mesh);
        if (isLocal) this.localCar = car;
      });
    };
    spawn(blueList, -1);   // 青チームは -Z 側スポーン -> +Z ゴールを狙う
    spawn(orgList, 1);

    this.ball.reset();

    // UI
    document.getElementById('hud-score-blue').textContent = '0';
    document.getElementById('hud-score-orange').textContent = '0';
    document.getElementById('hud-time').textContent = Utils.formatTime(this.matchDuration * 1000);

    this.running = true;
    this.lastFrameTime = performance.now();
    requestAnimationFrame(this._frame.bind(this));
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
  },

  _frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.update(dt);
    this.render();
    requestAnimationFrame(this._frame.bind(this));
  },

  update(dt) {
    Input.update(dt);

    // ゴール演出中 / カウントダウン中
    if (this.goalAnimTimer > 0) {
      this.goalAnimTimer -= dt;
      if (this.goalAnimTimer <= 0) {
        this._kickoffReset();
      }
    }

    // タイマー
    if (this.matchStarted && !this.matchEnded && this.goalAnimTimer <= 0) {
      this.matchTime += dt;
      const remain = Math.max(0, this.matchDuration - this.matchTime);
      document.getElementById('hud-time').textContent = Utils.formatTime(remain * 1000);
      if (remain <= 0) {
        // 終了判定
        let winner = 'draw';
        if (this.scoreBlue > this.scoreOrange) winner = 'blue';
        else if (this.scoreOrange > this.scoreBlue) winner = 'orange';
        if (Net.isHost || !Net.peer) {
          if (Net.isHost) Net.broadcastEnd({ winner, blue: this.scoreBlue, orange: this.scoreOrange });
          this.endMatch(winner);
        }
      }
    }

    // ===== ローカル車の更新 =====
    if (this.localCar) {
      const inputState = {
        steer: Input.steer,
        accel: Input.accel,
        brake: Input.brake,
        boost: Input.boost,
        jump: Input.consumeJump(),
      };
      // ジャンプはホストにも送るので保持
      this._lastLocalInput = inputState;
      this.localCar.update(dt, inputState);
    }

    // ===== オンライン処理 =====
    if (Net.peer && Net.isHost) {
      // ホスト: 他クライアントの車を彼らの入力でシム
      for (const [id, car] of this.cars) {
        if (car === this.localCar) continue;
        const inp = this.remoteInputs.get(id) || { steer: 0, accel: false, brake: false, boost: false, jump: false };
        car.update(dt, inp);
        // jumpは1回消費
        if (inp.jump) inp.jump = false;
      }
      // ボール物理
      this.ball.update(dt);
      // 衝突
      for (const car of this.cars.values()) {
        if (car.ballHitCooldown > 0) continue;
        this.ball.collideWithCar(car);
      }
      // ゴール判定
      if (this.goalAnimTimer <= 0) {
        const g = this.ball.checkGoal();
        if (g === 1) {
          // +Z 側 → 青チームが攻めるゴール = 青得点
          this.scoreBlue += 1;
          this._onGoal('blue');
        } else if (g === -1) {
          this.scoreOrange += 1;
          this._onGoal('orange');
        }
      }
      // 状態配信
      this._stateAccum += dt;
      if (this._stateAccum >= this._stateInterval) {
        this._stateAccum = 0;
        const carStates = [];
        for (const car of this.cars.values()) {
          carStates.push(car.getNetState(Input.boost && car === this.localCar));
        }
        Net.broadcastState({
          cars: carStates,
          ball: this.ball.getNetState(),
          scoreBlue: this.scoreBlue,
          scoreOrange: this.scoreOrange,
          matchTime: this.matchTime,
          goalAnim: this.goalAnimTimer,
        });
      }
    } else if (Net.peer && !Net.isHost) {
      // クライアント: ローカル車の入力をホストに送る
      Net.sendToHost({ type: 'input', input: {
        steer: Input.steer,
        accel: Input.accel,
        brake: Input.brake,
        boost: Input.boost,
        jump: this._lastLocalInput ? this._lastLocalInput.jump : false,
      }});
    } else {
      // ソロ: 自分でボールも回す
      this.ball.update(dt);
      for (const car of this.cars.values()) {
        if (car !== this.localCar) {
          // ソロBotの簡易行動: ボールに向かう
          this._botUpdate(car, dt);
        }
        if (car.ballHitCooldown > 0) continue;
        this.ball.collideWithCar(car);
      }
      if (this.goalAnimTimer <= 0) {
        const g = this.ball.checkGoal();
        if (g === 1) { this.scoreBlue++; this._onGoal('blue'); }
        else if (g === -1) { this.scoreOrange++; this._onGoal('orange'); }
      }
    }

    // ===== カメラ追従 (ロケットリーグ風: 車後方上方) =====
    if (this.localCar) {
      this._updateCamera();
    }

    // ===== HUD =====
    const boostPct = this.localCar ? Math.round(this.localCar.boost) : 0;
    const bf = document.getElementById('boost-fill');
    if (bf) bf.style.width = boostPct + '%';
    const bv = document.getElementById('boost-val');
    if (bv) bv.textContent = boostPct;
    const sv = document.getElementById('hud-speed');
    if (sv && this.localCar) {
      const sp = Math.round(Math.sqrt(this.localCar.vx**2 + this.localCar.vy**2 + this.localCar.vz**2) * 3.6);
      sv.textContent = sp;
    }

    // ブーストパッド時刻
    Arena.updatePads(dt, performance.now());
  },

  // クライアント: ホストからの状態適用
  applyAuthState(state) {
    if (Net.isHost) return;
    if (state.cars) {
      for (const cs of state.cars) {
        const car = this.cars.get(cs.id);
        if (!car) continue;
        if (car === this.localCar) {
          // ローカル車は権威データを軽く補正 (ハードリセットしない)
          car.x = Utils.lerp(car.x, cs.x, 0.18);
          car.y = Utils.lerp(car.y, cs.y, 0.18);
          car.z = Utils.lerp(car.z, cs.z, 0.18);
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
    if (typeof state.goalAnim === 'number') {
      this.goalAnimTimer = state.goalAnim;
    }
  },

  _onGoal(team) {
    this.goalAnimTimer = 3.0;
    const banner = document.getElementById('goal-banner');
    if (banner) {
      banner.textContent = team === 'blue' ? '🔵 GOAL! (BLUE)' : '🟠 GOAL! (ORANGE)';
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

  // ホスト用: クライアントのGoal受信時 (クライアント側は表示のみ)
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
    // 車も初期位置へ
    const blueList = Array.from(this.cars.values()).filter(c => c.team === 'blue');
    const orgList = Array.from(this.cars.values()).filter(c => c.team === 'orange');
    const resetTeam = (list, zSign) => {
      list.forEach((c, i) => {
        const xOff = (i - (list.length - 1) / 2) * 8;
        c.x = xOff;
        c.z = zSign * (Arena.L / 2 - 15);
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
  },

  _updateCamera() {
    const car = this.localCar;
    // 後方+上方からの追従
    const back = 16;
    const up = 7;
    const camX = car.x - Math.sin(car.angle) * back;
    const camZ = car.z - Math.cos(car.angle) * back;
    const camY = car.y + up;
    // ラープでスムージング
    this.camera.position.x = Utils.lerp(this.camera.position.x, camX, 0.18);
    this.camera.position.y = Utils.lerp(this.camera.position.y, camY, 0.18);
    this.camera.position.z = Utils.lerp(this.camera.position.z, camZ, 0.18);
    // 見る先: 車のちょい前
    const lookX = car.x + Math.sin(car.angle) * 4;
    const lookZ = car.z + Math.cos(car.angle) * 4;
    this.camera.lookAt(lookX, car.y + 1, lookZ);
  },

  render() {
    this.renderer.render(this.scene, this.camera);
  },

  // ====== ソロモード用 簡易Bot ======
  _botUpdate(car, dt) {
    // ターゲット: ボール (自陣側にいるとき) または 相手ゴール方向
    const ownGoalZ = car.team === 'blue' ? -Arena.L/2 : Arena.L/2;
    const enemyGoalZ = -ownGoalZ;
    const tx = this.ball.x;
    const tz = this.ball.z + (enemyGoalZ - this.ball.z) * 0.1;
    const dx = tx - car.x;
    const dz = tz - car.z;
    const targetAngle = Math.atan2(dx, dz);
    let da = targetAngle - car.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steer = Utils.clamp(da * 2.0, -1, 1);
    const dist = Math.sqrt(dx*dx + dz*dz);
    const inp = {
      steer,
      accel: dist > 3,
      brake: false,
      boost: dist > 20 && car.boost > 10 && Math.abs(da) < 0.4,
      jump: false,
    };
    // たまにジャンプ (ボールが上にあるとき)
    if (this.ball.y > 5 && dist < 8 && Math.random() < 0.05) inp.jump = true;
    car.update(dt, inp);
  },
};

// ホスト: クライアント入力受信
if (typeof Net !== 'undefined') {
  Net.on('clientInput', (id, input) => {
    Game.remoteInputs.set(id, input);
  });
  Net.on('state', (st) => Game.applyAuthState(st));
  Net.on('goal', (info) => Game.applyGoal(info));
  Net.on('gameEnd', (info) => Game.applyEnd(info));
}

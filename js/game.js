// ============= ゲームメイン (シーン/カメラ/ループ/ホストシム) =============
// 主な改良点 (この版):
//  - 致命バグ修正: ゴール後固まる問題 (PowerUps の Group dispose クラッシュ)
//  - パーティクルをオブジェクトプール化して GC/dispose のコストを削減
//  - クライアントでもボールを内挿補間して 60fps で滑らかに描画
//  - シャドウ品質をモバイル向けに自動調整 (軽量化)
//  - スローモーション演出 (ゴール時) + シュートインジケータ
//  - ゲーム終了画面の統計情報 (ゴール/アシスト/デモ)
//  - キックオフカウントダウンを画面に表示
//  - ローカル車のゴール時に専用バナーとフラッシュ
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
  _slowmoT: 0,           // ゴール時スローモーション残り時間 (秒)

  // ホストシム
  matchSize: 3,
  myInfo: { id: 'me', name: 'Player', color: '#E53935', team: 'blue' },
  botDifficulty: 'normal', // 'easy' | 'normal' | 'hard'

  _stateAccum: 0,
  _stateInterval: 1 / 20,

  lastFrameTime: 0,
  running: false,
  paused: false,

  // パーティクル (オブジェクトプール化)
  _particlePool: [],
  _particleMax: 120,     // 最大同時パーティクル数。これ以上は出さない
  _activeParticles: [],

  // 統計情報 (per car: { goals, assists, demos, demoed })
  stats: new Map(),

  // カメラモード ('chase' = 後方追従、'ball' = ボール視点 (車→ボール方向))
  cameraMode: 'chase',
  ballCamDefault: false,

  // コンボシステム (ローカルプレイヤーの連続ヒット数)
  comboCount: 0,
  comboTimer: 0,
  COMBO_WINDOW: 2.5, // 秒

  init() {
    this.canvas = document.getElementById('game-canvas');
    const scene = new THREE.Scene();
    // 夜間スタジアム風: 深い青紫
    scene.background = new THREE.Color(0x0a1428);
    scene.fog = new THREE.Fog(0x0a1428, Arena.L * 0.45, Arena.L * 2.6);
    this.scene = scene;

    const aspect = window.innerWidth / window.innerHeight;
    // 基本FOV=68 (キビキビ感とスケール感のバランス)。ブースト中に動的に上がる。
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.1, 5200);
    this.camera.position.set(0, 40, -120);
    this.camera.lookAt(0, 0, 0);
    this._camLook = { x: 0, y: 0, z: 0 };
    this._camShake = 0;

    // === レンダラー: 端末性能に応じて軽量化 ===
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this._wantAA(),
      powerPreference: 'high-performance',
    });
    // モバイルは pixelRatio 上限 1.5 (軽量化)。デスクトップは 2。
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    const maxPR = isMobile ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPR));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = isMobile ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;

    // === ライティング: 夜間スタジアム風 ===
    const amb = new THREE.AmbientLight(0xb0c4ff, 0.42);
    scene.add(amb);
    // メインの天上ライト (スタジアム照明)
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(Arena.W * 0.45, Arena.H * 0.9, Arena.L * 0.35);
    sun.castShadow = true;
    // モバイルではシャドウマップ縮小
    const shadowSize = isMobile ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const shadowSpan = Math.max(Arena.W, Arena.L) * 0.65;
    sun.shadow.camera.left = -shadowSpan;
    sun.shadow.camera.right = shadowSpan;
    sun.shadow.camera.top = shadowSpan;
    sun.shadow.camera.bottom = -shadowSpan;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = Arena.H * 3.8;
    scene.add(sun);

    // 反対側からのフィルライト (青寄り)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-Arena.W * 0.5, Arena.H * 0.65, -Arena.L * 0.3);
    scene.add(fill);

    // チームカラーの間接光 (両ゴール側)
    const goalLightBlue = new THREE.PointLight(0x29b6f6, 0.65, Arena.L * 0.8, 2);
    goalLightBlue.position.set(0, Arena.H * 0.35, -Arena.L / 2);
    scene.add(goalLightBlue);
    const goalLightOrg = new THREE.PointLight(0xff7043, 0.65, Arena.L * 0.8, 2);
    goalLightOrg.position.set(0, Arena.H * 0.35, Arena.L / 2);
    scene.add(goalLightOrg);

    // ヘミスフィア (空青/床ダーク)
    const hemi = new THREE.HemisphereLight(0x4a6fb0, 0x101820, 0.4);
    scene.add(hemi);

    Arena.build(scene);
    this.ball = new Ball(scene);

    if (typeof PowerUps !== 'undefined') PowerUps.init(scene);
    if (typeof Minimap !== 'undefined')  Minimap.init();
    if (typeof QuickChat !== 'undefined') QuickChat.init();

    // パーティクルプール初期化
    this._initParticlePool();

    // カメラモード復元 (ローカルストレージ)
    try {
      const saved = localStorage.getItem('soccer-ballcam');
      if (saved === '1') {
        this.ballCamDefault = true;
        this.cameraMode = 'ball';
      }
    } catch (_) {}

    window.addEventListener('resize', () => this._onResize());
  },

  toggleCameraMode() {
    this.cameraMode = (this.cameraMode === 'chase') ? 'ball' : 'chase';
    if (typeof showToast === 'function') {
      showToast(this.cameraMode === 'ball' ? '🎥 ボール視点' : '🎥 通常視点', 900);
    }
  },

  _wantAA() {
    // モバイル小型端末は AA を OFF (軽量化)
    if (!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '')) return true;
    // 高解像度端末は AA OFF でも見栄え良いので OFF
    if ((window.devicePixelRatio || 1) >= 2) return false;
    return true;
  },

  // パーティクルをプールから取得 / 返却する仕組み (GC を抑える)
  _initParticlePool() {
    this._particlePool = [];
    this._activeParticles = [];
    for (let i = 0; i < this._particleMax; i++) {
      const geo = new THREE.SphereGeometry(0.5, 6, 4);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      this.scene.add(m);
      this._particlePool.push({ mesh: m, mat, active: false, life: 0, max: 0, vx: 0, vy: 0, vz: 0 });
    }
  },

  _acquireParticle() {
    for (const p of this._particlePool) {
      if (!p.active) return p;
    }
    return null;
  },

  _releaseParticle(p) {
    p.active = false;
    p.mesh.visible = false;
    p.mat.opacity = 0;
    const idx = this._activeParticles.indexOf(p);
    if (idx >= 0) this._activeParticles.splice(idx, 1);
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
    this._slowmoT = 0;
    this.matchDuration = opts.duration || 300;
    this.kickoffCountdown = 3.0;
    this.stats = new Map();

    // パワーアップもクリア (前試合の残りを消す)
    if (typeof PowerUps !== 'undefined') PowerUps.reset();
    // パーティクルもクリア
    for (const p of this._activeParticles.slice()) this._releaseParticle(p);

    // スポーン
    const blueList = players.filter(p => p.team === 'blue');
    const orgList  = players.filter(p => p.team === 'orange');
    const spawn = (list, zSign) => {
      list.forEach((p, i) => {
        const xOff = (i - (list.length - 1) / 2) * 16;
        const isLocal = (p.id === this.myInfo.id) || p.isLocal;
        const car = new Car({
          id: p.id, name: p.name, color: p.color, team: p.team,
          isLocal, isRemote: !isLocal,
          x: xOff, z: zSign * (Arena.L / 2 - 20 * Arena.SCALE),
          angle: zSign < 0 ? 0 : Math.PI,
        });
        this.cars.set(p.id, car);
        this.scene.add(car.mesh);
        if (isLocal) this.localCar = car;
        // 統計初期化
        this.stats.set(p.id, {
          name: p.name, team: p.team, color: p.color,
          goals: 0, assists: 0, demos: 0, demoed: 0, boostPads: 0,
        });
      });
    };
    spawn(blueList, -1);
    spawn(orgList, 1);

    this.ball.reset();

    document.getElementById('hud-score-blue').textContent = '0';
    document.getElementById('hud-score-orange').textContent = '0';
    document.getElementById('hud-time').textContent = Utils.formatTime(this.matchDuration * 1000);
    document.getElementById('finish-overlay').classList.remove('show');

    // カメラデフォルト適用
    this.cameraMode = this.ballCamDefault ? 'ball' : 'chase';
    // コンボリセット
    this.comboCount = 0;
    this.comboTimer = 0;

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

  // キックオフ後の小カウントダウンを表示
  _showMiniCountdown() {
    const el = document.getElementById('countdown');
    if (!el) return;
    el.textContent = 'GO!';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    SFX.countBeep(false);
    setTimeout(() => el.classList.remove('show'), 700);
  },

  endMatch(winner) {
    this.matchEnded = true;
    this.running = false;
    const titleEl = document.getElementById('finish-title');
    if (winner === 'blue') titleEl.textContent = '🔵 BLUE WIN!';
    else if (winner === 'orange') titleEl.textContent = '🟠 ORANGE WIN!';
    else titleEl.textContent = '🤝 DRAW';
    document.getElementById('finish-score').textContent = `${this.scoreBlue} - ${this.scoreOrange}`;
    // 統計を生成
    this._renderFinishStats();
    document.getElementById('finish-overlay').classList.add('show');
    SFX.goal();
  },

  _renderFinishStats() {
    const host = document.getElementById('finish-stats');
    if (!host) return;
    host.innerHTML = '';
    // 各プレイヤーのスタッツを並べる
    const rows = Array.from(this.stats.values());
    rows.sort((a, b) => (b.goals - a.goals) || (b.assists - a.assists) || (b.demos - a.demos));
    for (const s of rows) {
      const div = document.createElement('div');
      div.className = 'stat-row stat-team-' + (s.team || 'blue');
      div.innerHTML = `
        <span class="stat-dot" style="background:${s.color}"></span>
        <span class="stat-name">${escapeHtml(s.name || '?')}</span>
        <span class="stat-cell">⚽ ${s.goals}</span>
        <span class="stat-cell">🅰️ ${s.assists}</span>
        <span class="stat-cell">💥 ${s.demos}</span>
      `;
      host.appendChild(div);
    }
  },

  _frame(now) {
    if (!this.running) return;
    let rawDt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    let dt = rawDt;
    // スローモーション中は dt を縮める (描画は通常 fps、物理が遅くなる)
    if (this._slowmoT > 0) {
      this._slowmoT = Math.max(0, this._slowmoT - rawDt);
      dt = rawDt * 0.45;
    }
    if (!this.paused) this.update(dt);
    this.render();

    // FPS 計測 (パフォーマンス自動調整用)
    this._fpsAccum = (this._fpsAccum || 0) + 1;
    this._fpsTimer = (this._fpsTimer || 0) + dt;
    if (this._fpsTimer >= 1.0) {
      this._fps = this._fpsAccum / this._fpsTimer;
      this._fpsAccum = 0;
      this._fpsTimer = 0;
      // 自動軽量化: 30fps 未満が連続したらシャドウオフ
      if (this._fps < 28 && this.renderer && this.renderer.shadowMap.enabled && !this._autoLightApplied) {
        this.renderer.shadowMap.enabled = false;
        this._autoLightApplied = true;
        console.log('[perf] fps low (', this._fps.toFixed(1), '), disabling shadows');
      }
    }
    requestAnimationFrame(this._frame.bind(this));
  },

  update(dt) {
    Input.update(dt);

    // カメラ切替リクエスト処理
    if (Input.consumeCameraToggle()) {
      this.toggleCameraMode();
    }

    // コンボタイマー: 時間切れでリセット
    if (this.comboCount > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this._updateComboHUD();
      }
    }

    // タイマー破損の保険
    if (!Number.isFinite(this.kickoffCountdown)) this.kickoffCountdown = 0;
    if (!Number.isFinite(this.goalAnimTimer)) this.goalAnimTimer = 0;

    // ゴール演出中
    if (this.goalAnimTimer > 0) {
      this.goalAnimTimer -= dt;
      if (this.goalAnimTimer <= 0) {
        this.goalAnimTimer = 0;
        // ホストもしくはソロのみキックオフリセットを実行 (クライアントは状態同期で受け取る)
        if (Net.isHost || !Net.peer) {
          this._kickoffReset();
        }
      }
    }
    // キックオフ前カウントダウン中は車もボールも動かさない
    if (this.kickoffCountdown > 0) {
      const prev = this.kickoffCountdown;
      this.kickoffCountdown = Math.max(0, this.kickoffCountdown - dt);
      // 0 になる直前に GO! を表示 (ゴール後の小カウントダウンのみ。初回は _showCountdown が表示)
      // 初回キックオフは matchTime が 0 で、_showCountdown が裏で動いてるので重複させない
      if (prev > 0 && this.kickoffCountdown <= 0 && this.matchStarted && !this.matchEnded
          && this.matchTime > 0.5) {
        this._showMiniCountdown();
      }
    }
    const playLocked = this.kickoffCountdown > 0 || this.goalAnimTimer > 0;

    // タイマー
    if (this.matchStarted && !this.matchEnded && !playLocked) {
      this.matchTime += dt;
      const remain = Math.max(0, this.matchDuration - this.matchTime);
      document.getElementById('hud-time').textContent = Utils.formatTime(remain * 1000);
      if (remain <= 0) {
        let winner = 'draw';
        if (this.scoreBlue > this.scoreOrange) winner = 'blue';
        else if (this.scoreOrange > this.scoreBlue) winner = 'orange';
        if (Net.isHost || !Net.peer) {
          if (Net.isHost) Net.broadcastEnd({ winner, blue: this.scoreBlue, orange: this.scoreOrange, stats: this._statsForNet() });
          this.endMatch(winner);
        }
      }
    }

    // ===== ローカル車の入力組み立て =====
    let inputState = null;
    if (this.localCar && !playLocked) {
      inputState = {
        steer: Input.steer,
        accel: Input.accel,
        brake: Input.brake,
        boost: Input.boost,
        jump: Input.consumeJump(),
        airRoll: Input.airRoll,
      };
      this._lastLocalInput = inputState;
      this.localCar.update(dt, inputState);
      // ジャンプSFX
      if (inputState.jump) {
        if (this.localCar.jumpsUsed === 1) SFX.jump();
        else { SFX.doubleJump(); SFX.flip && SFX.flip(); }
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
        if (playLocked) {
          car.update(dt, null);
          continue;
        }
        let inp = this.remoteInputs.get(id);
        if (!inp) inp = { steer: 0, accel: false, brake: false, boost: false, jump: false, airRoll: false };
        car.update(dt, inp);
        if (inp.jump) inp.jump = false;
      }
      // ボール物理
      if (!playLocked) {
        this.ball.update(dt);
        // 衝突
        for (const car of this.cars.values()) {
          if (car.ballHitCooldown > 0) continue;
          const hitSp = this.ball.collideWithCar(car);
          if (hitSp > 0) this._onBallHit(car, hitSp);
        }
        // 車同士の弱い衝突
        this._resolveCarVsCar();

        // ゴール判定 (goalAnimTimer中は判定スキップで連続ゴール防止)
        if (this.goalAnimTimer <= 0) {
          const g = this.ball.checkGoal();
          if (g === 1) { this.scoreBlue += 1; this._onGoal('blue'); }
          else if (g === -1) { this.scoreOrange += 1; this._onGoal('orange'); }
        }
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
        accel: Input.accel,
        brake: Input.brake,
        boost: Input.boost,
        jump: this._lastLocalInput ? this._lastLocalInput.jump : false,
        airRoll: Input.airRoll,
      }});
      // クライアントでもボールを軽く前進補間 (パケット間がカクつくのを防ぐ)
      if (!playLocked && this.ball) this.ball.clientPredict(dt);
    } else {
      // ソロ: 自分でボール・Bot
      if (!playLocked) {
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
        if (this.goalAnimTimer <= 0) {
          const g = this.ball.checkGoal();
          if (g === 1) { this.scoreBlue++; this._onGoal('blue'); }
          else if (g === -1) { this.scoreOrange++; this._onGoal('orange'); }
        }
      } else if (playLocked) {
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

    // パーティクル
    this._updateParticles(dt);

    // パワーアップ更新: 全員アニメ実行、スポーン/判定はホストまたはソロのみ
    // (PowerUps.update 自体がホストならスポーン、クライアントなら return で
    //  アニメだけして接触判定をスキップする仕組みになっている)
    if (typeof PowerUps !== 'undefined') {
      if (!playLocked) PowerUps.update(dt);
    }
    // 全車の有効パワー効果適用 (見た目はクライアントでもやりたい)
    if (typeof PowerUps !== 'undefined') {
      for (const car of this.cars.values()) PowerUps.applyEffects(car, dt);
      PowerUps.tickHUD();
    }
    // ミニマップ
    if (typeof Minimap !== 'undefined') Minimap.draw();
  },

  _checkBoostPadSFX() {
    if (!this.localCar) return;
    const now = performance.now();
    if (now - this._lastBoostPadCheck < 80) return;
    this._lastBoostPadCheck = now;
    for (const p of Arena.boostPads) {
      if (p.active) continue;
      const dx = this.localCar.x - p.x;
      const dz = this.localCar.z - p.z;
      const r2 = (p.big ? Arena.PAD_PICKUP_RADIUS_BIG : Arena.PAD_PICKUP_RADIUS_SMALL);
      if (dx * dx + dz * dz < r2 * r2 + 1 && !p._sfxPlayed) {
        SFX.boostPad(p.big);
        p._sfxPlayed = true;
        // 統計
        const s = this.stats.get(this.localCar.id);
        if (s) s.boostPads++;
        // パッド復活時にリセット
        setTimeout(() => { p._sfxPlayed = false; }, (p.big ? 10000 : 4000));
        break;
      }
    }
  },

  // 車同士の押し合い + デモリッション判定 (高速ブースト車が遅い車を吹き飛ばす)
  _resolveCarVsCar() {
    const list = Array.from(this.cars.values());
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.respawnTimer > 0 || b.respawnTimer > 0) continue;
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
        // 速度反発
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy, rvz = b.vz - a.vz;
        const dot = rvx*nx + rvy*ny + rvz*nz;
        if (dot < 0) {
          const jImp = -(1 + 0.3) * dot * 0.5;
          a.vx -= nx * jImp; a.vy -= ny * jImp; a.vz -= nz * jImp;
          b.vx += nx * jImp; b.vy += ny * jImp; b.vz += nz * jImp;
          if (Math.abs(dot) > 12) {
            SFX.thud(Math.min(1, Math.abs(dot) / 30));
          }
          // === デモリッション判定 ===
          const spA = Math.sqrt(a.vx*a.vx + a.vy*a.vy + a.vz*a.vz);
          const spB = Math.sqrt(b.vx*b.vx + b.vy*b.vy + b.vz*b.vz);
          const isEnemy = a.team !== b.team;
          const DEMO_SPEED = 56;
          if (isEnemy && spA > DEMO_SPEED && spA > spB + 12) {
            this._demolish(b, a);
          } else if (isEnemy && spB > DEMO_SPEED && spB > spA + 12) {
            this._demolish(a, b);
          }
        }
      }
    }
  },

  // 車をデモる (一定時間消失→自陣付近にリスポーン)
  _demolish(victim, attacker) {
    if (victim.respawnTimer > 0) return;
    // シールドパワー所持者はデモ無効
    if (victim.activePower === 'shield') {
      this._spawnHitParticles(victim.x, victim.y + 1, victim.z, 30);
      SFX.boostPad(true);
      if (victim === this.localCar) showToast && showToast('🛡 シールドが守った！', 1200);
      return;
    }
    victim.respawnTimer = 3.0;
    victim.mesh.visible = false;
    SFX.ballSmash(1);
    // 爆発エフェクト
    this._spawnGoalExplosion(victim.x, victim.y, victim.z, victim.team);
    // 統計
    const sa = this.stats.get(attacker.id);
    const sv = this.stats.get(victim.id);
    if (sa) sa.demos++;
    if (sv) sv.demoed++;
    if (victim === this.localCar) {
      this.addCamShake(1.2);
      showToast && showToast(`💥 DEMOLISHED by ${attacker.name}!`, 1500);
    } else if (attacker === this.localCar) {
      showToast && showToast(`💥 NICE DEMO!`, 1200);
    }
  },

  _onBallHit(car, hitSpeed) {
    if (hitSpeed > 38) SFX.ballSmash(1);
    else SFX.ballHit(Utils.clamp(hitSpeed / 40, 0.2, 1));
    if (car === this.localCar) {
      this.addCamShake(Utils.clamp(hitSpeed / 50, 0.1, 1.0));
      // コンボ加算 (ローカル車だけ)
      this.comboCount++;
      this.comboTimer = this.COMBO_WINDOW;
      this._updateComboHUD();
      if (this.comboCount >= 2) SFX.combo(Math.min(this.comboCount, 6));
    }
    this._spawnHitParticles(this.ball.x, this.ball.y, this.ball.z, hitSpeed);
  },

  _updateComboHUD() {
    const el = document.getElementById('combo-meter');
    if (!el) return;
    const countEl = document.getElementById('combo-count');
    if (this.comboCount < 2) {
      el.classList.remove('show', 'big');
      return;
    }
    if (countEl) countEl.textContent = this.comboCount + 'x';
    el.classList.add('show');
    el.classList.remove('big');
    void el.offsetWidth;
    el.classList.add('big');
  },

  _spawnHitParticles(x, y, z, power) {
    const count = Math.min(10, 3 + Math.floor(power / 8));
    for (let i = 0; i < count; i++) {
      const p = this._acquireParticle();
      if (!p) break;
      const hue = Math.random() < 0.5 ? 0xffeb3b : 0xff7043;
      p.mat.color.setHex(hue);
      p.mat.opacity = 0.95;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, z);
      const sp = 6 + Math.random() * 12 + power * 0.15;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI - Math.PI / 2;
      p.vx = Math.cos(theta) * Math.cos(phi) * sp;
      p.vy = Math.sin(phi) * sp + 4;
      p.vz = Math.sin(theta) * Math.cos(phi) * sp;
      p.life = 0.55 + Math.random() * 0.35;
      p.max = 0.9;
      const s = 0.6 + Math.random() * 0.4;
      p.mesh.scale.set(s, s, s);
      p.active = true;
      this._activeParticles.push(p);
    }
  },

  _updateParticles(dt) {
    for (let i = this._activeParticles.length - 1; i >= 0; i--) {
      const p = this._activeParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this._releaseParticle(p);
        continue;
      }
      p.vy -= 26 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const a = Math.max(0, p.life / p.max);
      p.mat.opacity = a * 0.95;
      const s = 0.5 + a * 0.8;
      p.mesh.scale.set(s, s, s);
    }
  },

  // クライアント: ホスト状態の適用
  applyAuthState(state) {
    if (Net.isHost) return;
    if (state.cars) {
      for (const cs of state.cars) {
        const car = this.cars.get(cs.id);
        if (!car) continue;
        if (car === this.localCar) {
          // ローカル車は軽く補正のみ (リアル感保持)
          car.x = Utils.lerp(car.x, cs.x, 0.12);
          car.y = Utils.lerp(car.y, cs.y, 0.12);
          car.z = Utils.lerp(car.z, cs.z, 0.12);
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
    this.goalAnimTimer = 1.4;
    this._slowmoT = 0.7; // 0.7秒スローモーション
    this._lastSlowmoNow = performance.now();
    SFX.goal();
    // ゴール時にコンボリセット (味方ゴールならスペシャル演出)
    const myTeam = this.localCar ? this.localCar.team : null;
    if (myTeam === team && this.comboCount >= 2) {
      showToast && showToast(`🌟 ${this.comboCount}x COMBO GOAL!`, 1600);
    }
    this.comboCount = 0;
    this.comboTimer = 0;
    this._updateComboHUD();
    // ゴール献身者検出 (ホストまたはソロのみ)
    if (Net.isHost || !Net.peer) {
      const scorerId = this.ball.lastHitter;
      const scorer = scorerId ? this.cars.get(scorerId) : null;
      if (scorer && scorer.team === team) {
        const ss = this.stats.get(scorer.id);
        if (ss) ss.goals++;
        // アシスト判定 (ゴール前数秒以内に同チームが当てていればアシスト)
        if (this.ball.previousHitter && this.ball.previousHitter !== scorerId) {
          const prev = this.cars.get(this.ball.previousHitter);
          if (prev && prev.team === team) {
            const sa = this.stats.get(prev.id);
            if (sa) sa.assists++;
          }
        }
      }
    }
    const banner = document.getElementById('goal-banner');
    if (banner) {
      const myTeam = this.localCar ? this.localCar.team : null;
      let label;
      if (myTeam && myTeam === team) label = '🔥 GOOOAL! 🔥';
      else if (myTeam) label = '😱 CONCEDED!';
      else label = (team === 'blue' ? '🔵 BLUE SCORES!' : '🟠 ORANGE SCORES!');
      // スコアラー名を出す
      const scorerId = this.ball.lastHitter;
      const scorer = scorerId ? this.cars.get(scorerId) : null;
      if (scorer && scorer.team === team) {
        label += `\n${scorer.name}`;
      }
      banner.innerHTML = label.replace('\n', '<br><span class="goal-scorer">');
      if (banner.innerHTML.includes('<br><span class="goal-scorer">')) banner.innerHTML += '</span>';
      banner.style.color = team === 'blue' ? '#29b6f6' : '#ff7043';
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 1500);
    }
    // ボール周囲に大規模パーティクル爆発
    this._spawnGoalExplosion(this.ball.x, this.ball.y, this.ball.z, team);
    this.addCamShake(0.9);
    document.getElementById('hud-score-blue').textContent = String(this.scoreBlue);
    document.getElementById('hud-score-orange').textContent = String(this.scoreOrange);
    if (Net.isHost) {
      Net.broadcastGoal({ team, blue: this.scoreBlue, orange: this.scoreOrange, scorerId: this.ball.lastHitter });
    }
  },

  _spawnGoalExplosion(x, y, z, team) {
    const baseColor = team === 'blue' ? 0x29b6f6 : 0xff7043;
    const accent    = 0xffeb3b;
    // パーティクルプール残量に応じて最大粒数を制限 (軽量化)
    const target = Math.min(30, this._particlePool.length - this._activeParticles.length);
    for (let i = 0; i < target; i++) {
      const p = this._acquireParticle();
      if (!p) break;
      const useAccent = Math.random() < 0.3;
      p.mat.color.setHex(useAccent ? accent : baseColor);
      p.mat.opacity = 1;
      p.mesh.visible = true;
      p.mesh.position.set(x, y, z);
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.random() * Math.PI - Math.PI / 2;
      const sp    = 12 + Math.random() * 26;
      p.vx = Math.cos(theta) * Math.cos(phi) * sp;
      p.vy = Math.abs(Math.sin(phi) * sp) + 5;
      p.vz = Math.sin(theta) * Math.cos(phi) * sp;
      p.life = 1.0 + Math.random() * 0.6;
      p.max = 1.6;
      const s = 0.8 + Math.random() * 0.5;
      p.mesh.scale.set(s, s, s);
      p.active = true;
      this._activeParticles.push(p);
    }
  },

  applyGoal(info) {
    if (Net.isHost) return;
    this.scoreBlue = info.blue;
    this.scoreOrange = info.orange;
    // スコアラー情報を上書き (アシスト計算用)
    if (info.scorerId) this.ball.lastHitter = info.scorerId;
    this._onGoal(info.team);
  },

  applyEnd(info) {
    if (Net.isHost) return;
    this.scoreBlue = info.blue;
    this.scoreOrange = info.orange;
    // 統計を反映
    if (info.stats) {
      this.stats = new Map();
      for (const s of info.stats) this.stats.set(s.id, s);
    }
    this.endMatch(info.winner);
  },

  _statsForNet() {
    return Array.from(this.stats.entries()).map(([id, s]) => ({ id, ...s }));
  },

  _kickoffReset() {
    this.ball.reset();
    this.goalAnimTimer = 0;
    const blueList = Array.from(this.cars.values()).filter(c => c.team === 'blue');
    const orgList = Array.from(this.cars.values()).filter(c => c.team === 'orange');
    const resetTeam = (list, zSign) => {
      list.forEach((c, i) => {
        const xOff = (i - (list.length - 1) / 2) * 16;
        c.x = xOff;
        c.z = zSign * (Arena.L / 2 - 20 * Arena.SCALE);
        c.y = CarPhys.HEIGHT;
        c.vx = c.vy = c.vz = 0;
        c.speed = 0;
        c.angle = zSign < 0 ? 0 : Math.PI;
        c.pitch = 0; c.roll = 0;
        c.onGround = true;
        c.jumpsUsed = 0;
        c.lockTimer = 0;
        c.ballHitCooldown = 0;
        c.respawnTimer = 0;
        c.mesh.visible = true;
        c.boost = Math.max(c.boost, CarPhys.BOOST_INITIAL);
        // パワーアップ解除
        c.activePower = null;
        c.powerTimer = 0;
        if (c._giantScale) { c.mesh.scale.set(1,1,1); c._giantScale = false; }
        // 状態フラグもクリア
        c.isSupersonic = false;
        c.isFlipping = false;
        if (c._ssTrail) c._ssTrail.material.opacity = 0;
        c.syncMesh();
      });
    };
    resetTeam(blueList, -1);
    resetTeam(orgList, 1);
    // パワーアップボックスもクリアして再スポーン待ち
    if (typeof PowerUps !== 'undefined') PowerUps.reset();
    this.kickoffCountdown = 0.8;
    if (typeof PowerUps !== 'undefined') PowerUps._renderIndicator();
    // クライアントにキックオフリセット通知 (PowerUps クリア用)
    if (Net.isHost && typeof Net._broadcast === 'function') {
      Net._broadcast({ type: 'kickoffReset' });
    }
  },

  _updateCamera(dt) {
    const car = this.localCar;
    const sp = Math.abs(car.speed);
    const speedRatio = Utils.clamp(sp / CarPhys.MAX_SPEED, 0, 1);
    const boostRatio = Utils.clamp((sp - CarPhys.MAX_SPEED) / (CarPhys.MAX_SPEED_BOOST - CarPhys.MAX_SPEED), 0, 1);

    let camX, camY, camZ, lookX, lookY, lookZ;

    if (this.cameraMode === 'ball') {
      // ===== ボール視点: カメラは「車→ボール」方向に向いて配置 =====
      const dxb = this.ball.x - car.x;
      const dzb = this.ball.z - car.z;
      const dist = Math.sqrt(dxb*dxb + dzb*dzb);
      let dirX = 0, dirZ = 1;
      if (dist > 0.5) {
        dirX = dxb / dist;
        dirZ = dzb / dist;
      } else {
        // 接近時は車の向きを使う
        dirX = Math.sin(car.angle);
        dirZ = Math.cos(car.angle);
      }
      const baseBack = 24.0;
      const baseUp = 11.0;
      const dynBack = baseBack + speedRatio * 6.0;
      const dynUp = baseUp + speedRatio * 2.2;
      camX = car.x - dirX * dynBack;
      camZ = car.z - dirZ * dynBack;
      const airUp = car.onGround ? 0 : Math.min(8.0, (car.y - CarPhys.HEIGHT) * 0.2);
      camY = car.y + dynUp + airUp;
      // ボールを注視
      lookX = this.ball.x;
      lookY = this.ball.y + 1.5;
      lookZ = this.ball.z;
    } else {
      // ===== 通常チェイス視点 =====
      const baseBack = 21.0;
      const baseUp   = 9.0;
      const dynBack = baseBack + speedRatio * 8.0 + boostRatio * 5.0;
      const dynUp   = baseUp   + speedRatio * 2.8;
      const airUp = car.onGround ? 0 : Math.min(8.0, (car.y - CarPhys.HEIGHT) * 0.2);
      camX = car.x - Math.sin(car.angle) * dynBack;
      camZ = car.z - Math.cos(car.angle) * dynBack;
      camY = car.y + dynUp + airUp;

      // ボールトラッキング (車の進行方向+ボール方向ブレンド)
      const dxb = this.ball.x - car.x;
      const dzb = this.ball.z - car.z;
      const distBall = Math.sqrt(dxb*dxb + dzb*dzb);

      const forwardLookDist = 26 + speedRatio * 14;
      lookX = car.x + Math.sin(car.angle) * forwardLookDist;
      lookZ = car.z + Math.cos(car.angle) * forwardLookDist;
      lookY = car.y + 2.0;

      const ballMaxDist = 240;
      if (distBall < ballMaxDist) {
        const fx = Math.sin(car.angle), fz = Math.cos(car.angle);
        const bnx = dxb / Math.max(0.01, distBall);
        const bnz = dzb / Math.max(0.01, distBall);
        const dot = fx * bnx + fz * bnz;
        const distW = Utils.clamp(1 - distBall / ballMaxDist, 0, 1);
        const dirW  = Utils.clamp((dot + 0.3) / 1.3, 0, 1);
        const w = distW * dirW * 0.6;
        lookX = lookX * (1 - w) + this.ball.x * w;
        lookY = lookY * (1 - w) + (this.ball.y + 1) * w;
        lookZ = lookZ * (1 - w) + this.ball.z * w;
      }
    }

    // 視点切替時に急に飛ばないよう、補間係数は速度に応じて
    const alpha = Utils.clamp(0.18 + speedRatio * 0.18, 0.18, 0.38);
    this.camera.position.x = Utils.lerp(this.camera.position.x, camX, alpha);
    this.camera.position.y = Utils.lerp(this.camera.position.y, camY, alpha);
    this.camera.position.z = Utils.lerp(this.camera.position.z, camZ, alpha);

    if (!this._camLook) this._camLook = { x: lookX, y: lookY, z: lookZ };
    const lookAlpha = this.cameraMode === 'ball' ? 0.18 : 0.22;
    this._camLook.x = Utils.lerp(this._camLook.x, lookX, lookAlpha);
    this._camLook.y = Utils.lerp(this._camLook.y, lookY, lookAlpha * 0.85);
    this._camLook.z = Utils.lerp(this._camLook.z, lookZ, lookAlpha);

    this.camera.lookAt(this._camLook.x, this._camLook.y, this._camLook.z);

    const baseFov = 68;
    const boostFovAdd = boostRatio * 10 + speedRatio * 5;
    const ssFovAdd = (car.isSupersonic ? 4 : 0);
    const targetFov = baseFov + boostFovAdd + ssFovAdd;
    this.camera.fov = Utils.lerp(this.camera.fov, targetFov, 0.08);
    this.camera.updateProjectionMatrix();

    if (this._camShake > 0) {
      const s = this._camShake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this._camShake = Math.max(0, this._camShake - dt * 6);
    }
  },

  addCamShake(power) {
    this._camShake = Math.max(this._camShake || 0, Math.min(1.5, power));
  },

  _updateHUD() {
    if (!this.localCar) return;
    const car = this.localCar;
    const boostPct = Math.round(car.boost);
    const ring = document.getElementById('boost-ring-fill');
    if (ring) {
      const C = 2 * Math.PI * 34;
      const offset = C * (1 - boostPct / 100);
      ring.setAttribute('stroke-dashoffset', offset.toFixed(1));
      let color = '#ff8800';
      if (boostPct < 30) color = '#ef5350';
      else if (boostPct > 70) color = '#ffeb3b';
      ring.setAttribute('stroke', color);
    }
    const bv = document.getElementById('boost-val');
    if (bv) bv.textContent = boostPct;

    const sv = document.getElementById('hud-speed');
    if (sv) {
      const sp = Math.round(Math.sqrt(car.vx**2 + car.vy**2 + car.vz**2) * 3.6);
      sv.textContent = sp;
      sv.classList.toggle('supersonic', !!car.isSupersonic);
    }

    // スーパーソニックインジケータ
    const ssEl = document.getElementById('supersonic-indicator');
    if (ssEl) ssEl.classList.toggle('show', !!car.isSupersonic);
    // 発動時のSFX (エッジ検知)
    if (car.isSupersonic && !this._lastSupersonic) {
      SFX.supersonic && SFX.supersonic();
    }
    this._lastSupersonic = !!car.isSupersonic;

    const bi = document.getElementById('brake-indicator');
    if (bi) bi.classList.toggle('show', !!Input.brake);

    const arrow = document.getElementById('gyro-arrow');
    if (arrow) {
      const pct = Utils.clamp(Input.steer, -1, 1);
      const x = 50 + pct * 45;
      arrow.style.left = x + '%';
      arrow.classList.toggle('brake', !!Input.brake);
    }

    // ボール方向インジケーター (画面外のとき、画面端で矢印)
    this._updateBallIndicator();
  },

  // 画面外のボールへの矢印を画面端に出す
  _updateBallIndicator() {
    const el = document.getElementById('ball-indicator');
    if (!el || !this.ball || !this.camera) return;
    // ボールの3D位置をスクリーンに投影
    const v = new THREE.Vector3(this.ball.x, this.ball.y, this.ball.z);
    const camPos = this.camera.position;
    // カメラより手前にあるかチェック
    const camFwd = new THREE.Vector3();
    this.camera.getWorldDirection(camFwd);
    const toBall = new THREE.Vector3(v.x - camPos.x, v.y - camPos.y, v.z - camPos.z);
    const fwdDot = camFwd.x * toBall.x + camFwd.y * toBall.y + camFwd.z * toBall.z;
    v.project(this.camera);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const sx = (v.x * 0.5 + 0.5) * W;
    const sy = (-v.y * 0.5 + 0.5) * H;
    // ボールが画面内に十分入っているなら矢印は不要
    const onScreen = fwdDot > 0 && sx > 80 && sx < W - 80 && sy > 80 && sy < H - 120;
    const dist = Math.sqrt(
      (this.ball.x - this.localCar.x) ** 2 +
      (this.ball.z - this.localCar.z) ** 2
    );
    if (onScreen) {
      el.classList.remove('show');
      return;
    }
    // 画面の中心から、ボール方向に向けてエッジに矢印を置く
    const cx = W / 2, cy = H / 2;
    let dx = sx - cx, dy = sy - cy;
    if (fwdDot < 0) {
      // 後ろ側にある: 強制的に画面下に出す
      dx = -dx; dy = Math.abs(dy);
      if (dy < 60) dy = 60;
    }
    const mag = Math.sqrt(dx*dx + dy*dy) || 1;
    // 画面端の安全マージン
    const marginX = 70, marginY = 90;
    const maxX = W / 2 - marginX;
    const maxY = H / 2 - marginY;
    // 矢印位置を画面端にクランプ
    const sxNorm = dx / mag;
    const syNorm = dy / mag;
    // 端まで延ばす倍率
    const tX = Math.abs(sxNorm) > 0.001 ? maxX / Math.abs(sxNorm) : Infinity;
    const tY = Math.abs(syNorm) > 0.001 ? maxY / Math.abs(syNorm) : Infinity;
    const t = Math.min(tX, tY);
    const px = cx + sxNorm * t;
    const py = cy + syNorm * t;
    el.style.left = (px - 30) + 'px';
    el.style.top = (py - 30) + 'px';
    el.style.marginLeft = '0';
    el.style.marginTop = '0';
    el.classList.add('show');
    const distEl = el.querySelector('.ball-dist');
    if (distEl) distEl.textContent = Math.round(dist) + 'm';
  },

  render() {
    this.renderer.render(this.scene, this.camera);
  },

  // ====== 強化Bot AI (難易度別) ======
  _botUpdate(car, dt) {
    if (car.respawnTimer > 0) { car.update(dt, null); return; }

    // 難易度パラメータ
    const diff = this.botDifficulty || 'normal';
    const skill = diff === 'easy' ? 0.55 : (diff === 'hard' ? 1.2 : 1.0);

    const ownGoalZ   = car.team === 'blue' ? -Arena.L/2 : Arena.L/2;
    const enemyGoalZ = -ownGoalZ;
    const ball = this.ball;
    const distToBall = Math.hypot(ball.x - car.x, ball.z - car.z);

    // 同チームの他Bot/プレイヤーよりボールに近いか?
    let isClosest = true;
    let closestDist = distToBall;
    for (const other of this.cars.values()) {
      if (other === car || other.team !== car.team || other.respawnTimer > 0) continue;
      const d = Math.hypot(ball.x - other.x, ball.z - other.z);
      if (d < closestDist - 0.5) {
        isClosest = false;
        closestDist = d;
      }
    }

    const ballDistOwn = Math.abs(ball.z - ownGoalZ);
    const ballHeadingOwn = (ownGoalZ < 0 && ball.vz < -2) || (ownGoalZ > 0 && ball.vz > 2);
    const emergencyDefense = ballDistOwn < 32 && ballHeadingOwn;

    // 危険な敵が自陣ボール近くに居るか? (ハード難易度はマーキング意識)
    let dangerEnemy = null;
    if (diff !== 'easy') {
      let dmin = 999;
      for (const other of this.cars.values()) {
        if (other.team === car.team || other.respawnTimer > 0) continue;
        const d = Math.hypot(ball.x - other.x, ball.z - other.z);
        if (d < dmin && d < 28) { dmin = d; dangerEnemy = other; }
      }
    }

    let targetX, targetZ;
    let wantBoost = false;
    let wantJump  = false;

    // ボール予測位置 (Hard では先読み)
    const predictT = diff === 'hard' ? 0.45 : (diff === 'normal' ? 0.22 : 0.05);
    const predX = ball.x + ball.vx * predictT;
    const predZ = ball.z + ball.vz * predictT;

    if (emergencyDefense || (!isClosest && ballDistOwn < 42)) {
      // 守備
      const t = 0.55;
      targetX = Utils.clamp(ball.x * (1 - t), -Arena.GOAL_W / 2 - 4, Arena.GOAL_W / 2 + 4);
      targetZ = ownGoalZ * t + ball.z * (1 - t);
      if (ballDistOwn < 18 && distToBall < 14) {
        targetX = ball.x;
        targetZ = ball.z;
        wantBoost = car.boost > 25 && diff !== 'easy';
      }
    } else if (isClosest) {
      // 攻撃: ボールの「敵ゴール反対側」に回り込んでから敵ゴール方向に打つ
      // ボール予測位置→敵ゴール中央のベクトル
      const bgx = 0 - predX;
      const bgz = enemyGoalZ - predZ;
      const bgLen = Math.hypot(bgx, bgz) || 1;
      const bgnx = bgx / bgLen, bgnz = bgz / bgLen;
      const approachDist = 8;
      targetX = predX - bgnx * approachDist;
      targetZ = predZ - bgnz * approachDist;
      if (distToBall < 8) {
        // 接触圏内: ボールを敵ゴール中央方向に押す
        targetX = ball.x + bgnx * 4;
        targetZ = ball.z + bgnz * 6;
        wantBoost = car.boost > 30 && diff !== 'easy';
      } else if (distToBall < 35) {
        wantBoost = car.boost > 40 * (diff === 'easy' ? 1.5 : 1);
      }
    } else {
      // サポート
      // 敵が居るならマーキング (ハードのみ)、それ以外は敵ゴール側に待機 + ブーストパッド集め
      if (dangerEnemy && diff === 'hard') {
        // 敵とゴールの間に位置取り
        const ex = dangerEnemy.x, ez = dangerEnemy.z;
        targetX = (ex + 0) / 2;
        targetZ = (ez + ownGoalZ) / 2;
      } else {
        targetX = ball.x * 0.4;
        targetZ = ball.z + (enemyGoalZ > 0 ? -14 : 14);
      }
      if (car.boost < 55) {
        let bestPad = null, bestD = 999;
        for (const p of Arena.boostPads) {
          if (!p.active) continue;
          if (!p.big && car.boost > 40) continue;
          const d = Math.hypot(p.x - car.x, p.z - car.z);
          // ペナルティ: 敵陣すぎるパッドは取らない
          const oneOwnSide = (p.z * (ownGoalZ < 0 ? 1 : -1)) > -10;
          if (oneOwnSide && d < bestD && d < 50) { bestPad = p; bestD = d; }
        }
        if (bestPad) { targetX = bestPad.x; targetZ = bestPad.z; }
      }
    }

    // ステアリング (難易度で精度ノイズ)
    const noise = (diff === 'easy' ? 0.45 : (diff === 'hard' ? 0.06 : 0.16)) * (Math.random() - 0.5);
    const dx = targetX - car.x;
    const dz = targetZ - car.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const targetAngle = Math.atan2(dx, dz) + noise;
    let da = targetAngle - car.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steer = Utils.clamp(da * 2.4 * skill, -1, 1);

    let brake = (Math.abs(da) > Math.PI * 0.72 && dist < 9);

    // エアプレー
    const jumpChance = diff === 'easy' ? 0.12 : (diff === 'hard' ? 0.78 : 0.5);
    if (ball.y > 8 && distToBall < 15 && car.onGround && Math.random() < jumpChance) {
      wantJump = true;
    }
    if (!car.onGround && car.jumpsUsed === 1 && distToBall < 8 && ball.y > car.y - 2 && Math.random() < 0.2 * skill) {
      wantJump = true;
    }

    // キックオフ突撃
    if (this.matchTime < 1.2 && isClosest) { wantBoost = true; brake = false; }

    // デモリッション狙い (Hard のみ、自陣で危険な敵が居て自分は守備でない時)
    if (diff === 'hard' && dangerEnemy && !isClosest && car.boost > 60) {
      const dToEnemy = Math.hypot(dangerEnemy.x - car.x, dangerEnemy.z - car.z);
      // 後ろから接近できる時のみ
      if (dToEnemy < 50 && dToEnemy > 12) {
        // 敵への角度
        const eda = Math.atan2(dangerEnemy.x - car.x, dangerEnemy.z - car.z) - car.angle;
        let edaN = eda;
        while (edaN > Math.PI) edaN -= Math.PI * 2;
        while (edaN < -Math.PI) edaN += Math.PI * 2;
        if (Math.abs(edaN) < 0.4) wantBoost = true;
      }
    }

    car.update(dt, {
      steer,
      accel: true,
      brake,
      boost: wantBoost && car.boost > 5 && Math.abs(da) < 0.6,
      jump: wantJump,
      airRoll: false,
    });
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
  Net.on('chat', (fromId, msg) => {
    const car = Game.cars.get(fromId);
    if (car && typeof QuickChat !== 'undefined') QuickChat.showBubble(car, msg);
  });
  Net.on('powerupTaken', (data) => {
    if (Net.isHost) return;
    const car = Game.cars.get(data.carId);
    if (!car || typeof PowerUps === 'undefined') return;
    const meta = PowerUps.META[data.kind];
    if (!meta) return;
    car.activePower = data.kind;
    car.powerTimer = meta.dur;
    if (car === Game.localCar) PowerUps._renderIndicator();
    // クライアント側の見た目同期: 取られたボックスを消す
    if (data.boxId) PowerUps.applyRemoteTake(data.boxId);
  });
  // クライアント: ホストからのスポーン通知
  Net.on('powerupSpawn', (data) => {
    if (typeof PowerUps !== 'undefined') PowerUps.applyRemoteSpawn(data);
  });
  // クライアント: ホストからのキックオフリセット通知
  Net.on('kickoffReset', () => {
    if (Net.isHost) return;
    if (typeof PowerUps !== 'undefined') PowerUps.reset();
    // 各車のパワー状態もクリア
    for (const car of Game.cars.values()) {
      car.activePower = null;
      car.powerTimer = 0;
      if (car._giantScale) { car.mesh.scale.set(1,1,1); car._giantScale = false; }
    }
    if (typeof PowerUps !== 'undefined') PowerUps._renderIndicator();
  });
}

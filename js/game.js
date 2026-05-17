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

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // === ライティング: 夜間スタジアム風 ===
    const amb = new THREE.AmbientLight(0xb0c4ff, 0.42);
    scene.add(amb);
    // メインの天上ライト (スタジアム照明)
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(Arena.W * 0.45, Arena.H * 0.9, Arena.L * 0.35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
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
        accel: Input.accel,
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
        if (!inp) inp = { steer: 0, accel: false, brake: false, boost: false, jump: false };
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
        accel: Input.accel,
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

    // パーティクル
    this._updateParticles(dt);

    // パワーアップ更新 (ホストまたはソロのみがスポーン/判定)
    if (typeof PowerUps !== 'undefined' && (Net.isHost || !Net.peer)) {
      if (!kickoffActive && this.goalAnimTimer <= 0) PowerUps.update(dt);
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
      const r2 = (p.big ? Arena.PAD_PICKUP_RADIUS_BIG : Arena.PAD_PICKUP_RADIUS_SMALL);
      if (dx * dx + dz * dz < r2 * r2 + 1 && !p._sfxPlayed) {
        SFX.boostPad(p.big);
        p._sfxPlayed = true;
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
        // リスポーン中はスキップ
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
          // 強衝突なら SFX
          if (Math.abs(dot) > 12) {
            SFX.thud(Math.min(1, Math.abs(dot) / 30));
          }
          // === デモリッション判定 ===
          // 一方のスピード差が大きく、敵チームならデモ
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
      // シールド使用: 跳ね返しのフラッシュ
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
    // ローカル車のボールヒット時にカメラシェイク
    if (car === this.localCar) {
      this.addCamShake(Utils.clamp(hitSpeed / 50, 0.1, 1.0));
    }
    // パーティクル (簡易)
    this._spawnHitParticles(this.ball.x, this.ball.y, this.ball.z, hitSpeed);
  },

  _spawnHitParticles(x, y, z, power) {
    if (!this.scene) return;
    const count = Math.min(14, 4 + Math.floor(power / 6));
    for (let i = 0; i < count; i++) {
      const geo = new THREE.SphereGeometry(0.35 + Math.random() * 0.4, 6, 4);
      const hue = Math.random() < 0.5 ? 0xffeb3b : 0xff7043;
      const mat = new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.95 });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, y, z);
      const sp = 6 + Math.random() * 12 + power * 0.15;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI - Math.PI / 2;
      this.scene.add(p);
      this._particles.push({
        mesh: p,
        vx: Math.cos(theta) * Math.cos(phi) * sp,
        vy: Math.sin(phi) * sp + 4,
        vz: Math.sin(theta) * Math.cos(phi) * sp,
        life: 0.55 + Math.random() * 0.35,
        max: 0.9,
      });
    }
  },

  _updateParticles(dt) {
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._particles.splice(i, 1);
        continue;
      }
      p.vy -= 26 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const a = Math.max(0, p.life / p.max);
      p.mesh.material.opacity = a;
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
    this.goalAnimTimer = 3.2;
    this._goalSlowmoT = 1.5; // スローモーション時間
    this._goalScorerTeam = team;
    SFX.goal();
    const banner = document.getElementById('goal-banner');
    if (banner) {
      const myTeam = this.localCar ? this.localCar.team : null;
      let label;
      if (myTeam && myTeam === team) label = '🔥 GOOOAL! 🔥';
      else if (myTeam) label = '😱 CONCEDED!';
      else label = (team === 'blue' ? '🔵 BLUE SCORES!' : '🟠 ORANGE SCORES!');
      banner.textContent = label;
      banner.style.color = team === 'blue' ? '#29b6f6' : '#ff7043';
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 2800);
    }
    // ボール周囲に大規模パーティクル爆発
    this._spawnGoalExplosion(this.ball.x, this.ball.y, this.ball.z, team);
    // カメラシェイク
    this.addCamShake(0.8);
    document.getElementById('hud-score-blue').textContent = String(this.scoreBlue);
    document.getElementById('hud-score-orange').textContent = String(this.scoreOrange);
    if (Net.isHost) {
      Net.broadcastGoal({ team, blue: this.scoreBlue, orange: this.scoreOrange });
    }
  },

  _spawnGoalExplosion(x, y, z, team) {
    const baseColor = team === 'blue' ? 0x29b6f6 : 0xff7043;
    const accent    = 0xffeb3b;
    for (let i = 0; i < 40; i++) {
      const geo = new THREE.SphereGeometry(0.5 + Math.random() * 0.6, 6, 4);
      const useAccent = Math.random() < 0.3;
      const mat = new THREE.MeshBasicMaterial({
        color: useAccent ? accent : baseColor,
        transparent: true, opacity: 1,
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, y, z);
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.random() * Math.PI - Math.PI / 2;
      const sp    = 12 + Math.random() * 26;
      this.scene.add(p);
      this._particles.push({
        mesh: p,
        vx: Math.cos(theta) * Math.cos(phi) * sp,
        vy: Math.abs(Math.sin(phi) * sp) + 5,
        vz: Math.sin(theta) * Math.cos(phi) * sp,
        life: 1.0 + Math.random() * 0.6,
        max: 1.6,
      });
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
        c.respawnTimer = 0;
        c.mesh.visible = true;
        c.boost = Math.max(c.boost, CarPhys.BOOST_INITIAL);
        // パワーアップ解除
        c.activePower = null;
        c.powerTimer = 0;
        if (c._giantScale) { c.mesh.scale.set(1,1,1); c._giantScale = false; }
        c.syncMesh();
      });
    };
    resetTeam(blueList, -1);
    resetTeam(orgList, 1);
    // パワーアップボックスもクリアして再スポーン待ち
    if (typeof PowerUps !== 'undefined') PowerUps.reset();
    this.kickoffCountdown = 1.5; // ゴール後の小カウントダウン
    // HUDも更新
    if (typeof PowerUps !== 'undefined') PowerUps._renderIndicator();
  },

  _updateCamera(dt) {
    const car = this.localCar;
    // ===== ロケットリーグ風シネマティックカメラ =====
    // 車のすぐ後ろ・低めから車を「でかく」捉える + ボールトラッキング
    // 基本距離を近く・低く。スピードでわずかに後退するのでスピード感も出る。
    const baseBack = 21.0;
    const baseUp   = 9.0;
    const sp = Math.abs(car.speed);
    const speedRatio = Utils.clamp(sp / CarPhys.MAX_SPEED, 0, 1);
    const boostRatio = Utils.clamp((sp - CarPhys.MAX_SPEED) / (CarPhys.MAX_SPEED_BOOST - CarPhys.MAX_SPEED), 0, 1);

    // 速度が上がるほど後ろに引く＋少しだけ上げる (ダイナミック感)
    const dynBack = baseBack + speedRatio * 8.0 + boostRatio * 5.0;
    const dynUp   = baseUp   + speedRatio * 2.8;

    // 空中時はカメラを少し上に
    const airUp = car.onGround ? 0 : Math.min(8.0, (car.y - CarPhys.HEIGHT) * 0.2);

    const camX = car.x - Math.sin(car.angle) * dynBack;
    const camZ = car.z - Math.cos(car.angle) * dynBack;
    const camY = car.y + dynUp + airUp;

    // スピードに応じてスムージング (高速ほどキビキビ)
    const alpha = Utils.clamp(0.18 + speedRatio * 0.18, 0.18, 0.38);
    this.camera.position.x = Utils.lerp(this.camera.position.x, camX, alpha);
    this.camera.position.y = Utils.lerp(this.camera.position.y, camY, alpha);
    this.camera.position.z = Utils.lerp(this.camera.position.z, camZ, alpha);

    // ===== ボールトラッキング (重要: 攻撃中は常にボールを見る) =====
    // 車前方の注視点。ボールが画面内に入るよう動的にブレンド
    const dxb = this.ball.x - car.x;
    const dzb = this.ball.z - car.z;
    const distBall = Math.sqrt(dxb*dxb + dzb*dzb);

    // 車前方の注視点を遠めに
    const forwardLookDist = 26 + speedRatio * 14;
    let lookX = car.x + Math.sin(car.angle) * forwardLookDist;
    let lookZ = car.z + Math.cos(car.angle) * forwardLookDist;
    let lookY = car.y + 2.0;

    // ボールが視野内かつ近いほど強くブレンド (最大 60%)
    const ballMaxDist = 240;
    if (distBall < ballMaxDist) {
      // 車正面方向とボール方向のドット積で「視野内」を判定
      const fx = Math.sin(car.angle), fz = Math.cos(car.angle);
      const bnx = dxb / Math.max(0.01, distBall);
      const bnz = dzb / Math.max(0.01, distBall);
      const dot = fx * bnx + fz * bnz;
      // 視野内 (dot > -0.3) かつ距離近いほどブレンド
      const distW = Utils.clamp(1 - distBall / ballMaxDist, 0, 1);
      const dirW  = Utils.clamp((dot + 0.3) / 1.3, 0, 1);
      const w = distW * dirW * 0.6;
      lookX = lookX * (1 - w) + this.ball.x * w;
      lookY = lookY * (1 - w) + (this.ball.y + 1) * w;
      lookZ = lookZ * (1 - w) + this.ball.z * w;
    }

    // 注視点もスムージング
    if (!this._camLook) this._camLook = { x: lookX, y: lookY, z: lookZ };
    this._camLook.x = Utils.lerp(this._camLook.x, lookX, 0.22);
    this._camLook.y = Utils.lerp(this._camLook.y, lookY, 0.18);
    this._camLook.z = Utils.lerp(this._camLook.z, lookZ, 0.22);

    this.camera.lookAt(this._camLook.x, this._camLook.y, this._camLook.z);

    // ===== ブースト時のFOVキック (スピード感アップ) =====
    const baseFov = 68;
    const boostFovAdd = boostRatio * 10 + speedRatio * 5;
    const targetFov = baseFov + boostFovAdd;
    this.camera.fov = Utils.lerp(this.camera.fov, targetFov, 0.08);
    this.camera.updateProjectionMatrix();

    // ===== カメラシェイク (衝突・ブースト・着地) =====
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

  // ====== 強化Bot AI: 役割分担(攻撃/守備/サポート)・空中プレー・ブースト管理 ======
  _botUpdate(car, dt) {
    if (car.respawnTimer > 0) { car.update(dt, null); return; }

    const ownGoalZ   = car.team === 'blue' ? -Arena.L/2 : Arena.L/2;
    const enemyGoalZ = -ownGoalZ;
    const ball = this.ball;
    const distToBall = Math.hypot(ball.x - car.x, ball.z - car.z);

    // チーム内で誰がボールに最も近いか
    let isClosest = true;
    for (const other of this.cars.values()) {
      if (other === car || other.team !== car.team || other.respawnTimer > 0) continue;
      const d = Math.hypot(ball.x - other.x, ball.z - other.z);
      if (d < distToBall - 0.5) { isClosest = false; break; }
    }

    const ballDistOwn = Math.abs(ball.z - ownGoalZ);
    const ballHeadingOwn = (ownGoalZ < 0 && ball.vz < -2) || (ownGoalZ > 0 && ball.vz > 2);
    const emergencyDefense = ballDistOwn < 32 && ballHeadingOwn;

    let targetX, targetZ;
    let wantBoost = false;
    let wantJump  = false;

    if (emergencyDefense || (!isClosest && ballDistOwn < 42)) {
      // 守備: 自陣ゴール前ライン
      const t = 0.55;
      targetX = Utils.clamp(ball.x * (1 - t), -Arena.GOAL_W / 2 - 4, Arena.GOAL_W / 2 + 4);
      targetZ = ownGoalZ * t + ball.z * (1 - t);
      if (ballDistOwn < 18 && distToBall < 14) {
        targetX = ball.x;
        targetZ = ball.z;
        wantBoost = car.boost > 25;
      }
    } else if (isClosest) {
      // 攻撃: ボールの手前に回り込んで敵ゴール方向に打ち抜く
      const goalDirZ = enemyGoalZ - ball.z;
      targetX = ball.x - (ball.x - 0) * 0.18;
      targetZ = ball.z - Math.sign(goalDirZ) * 6.5;
      if (distToBall < 8) {
        targetX = ball.x + (0 - ball.x) * 0.35;
        targetZ = enemyGoalZ;
        wantBoost = car.boost > 30;
      } else if (distToBall < 30) {
        wantBoost = car.boost > 40;
      }
    } else {
      // サポート: ボール斜め後方で待機 + ブーストパッドを拾う
      targetX = ball.x * 0.4;
      targetZ = ball.z + (enemyGoalZ > 0 ? -14 : 14);
      if (car.boost < 55) {
        for (const p of Arena.boostPads) {
          if (!p.active || !p.big) continue;
          const d = Math.hypot(p.x - car.x, p.z - car.z);
          if (d < 30) { targetX = p.x; targetZ = p.z; break; }
        }
      }
    }

    // ステアリング
    const dx = targetX - car.x;
    const dz = targetZ - car.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const targetAngle = Math.atan2(dx, dz);
    let da = targetAngle - car.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steer = Utils.clamp(da * 2.4, -1, 1);

    // 真後ろが目標なら一旦ブレーキ
    let brake = (Math.abs(da) > Math.PI * 0.72 && dist < 9);

    // エアプレー
    if (ball.y > 8 && distToBall < 14 && car.onGround && Math.random() < 0.55) {
      wantJump = true;
    }
    if (!car.onGround && car.jumpsUsed === 1 && distToBall < 7 && ball.y > car.y - 2 && Math.random() < 0.18) {
      wantJump = true;
    }

    // キックオフ突撃
    if (this.matchTime < 1.2 && isClosest) { wantBoost = true; brake = false; }

    car.update(dt, {
      steer,
      accel: true,
      brake,
      boost: wantBoost && car.boost > 5 && Math.abs(da) < 0.6,
      jump: wantJump,
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
  // チャットを受信した時、その車にバブル表示
  Net.on('chat', (fromId, msg) => {
    const car = Game.cars.get(fromId);
    if (car && typeof QuickChat !== 'undefined') QuickChat.showBubble(car, msg);
  });
  // パワーアップ取得通知 (クライアント側で見た目を更新)
  Net.on('powerupTaken', (data) => {
    if (Net.isHost) return;
    const car = Game.cars.get(data.carId);
    if (!car || typeof PowerUps === 'undefined') return;
    const meta = PowerUps.META[data.kind];
    if (!meta) return;
    car.activePower = data.kind;
    car.powerTimer = meta.dur;
    if (car === Game.localCar) PowerUps._renderIndicator();
  });
}

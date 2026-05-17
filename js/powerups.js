// ============= パワーアップシステム (オリジナル要素) =============
// フィールド上にランダムなアイテムボックスが出現。取ると一定時間のバフ。
// 種類:
//  - SHIELD: デモリッション耐性 (12秒)
//  - MAGNET: ボールを引き寄せる (10秒)
//  - GIANT:  車1.5倍&重く、ボールを吹き飛ばしやすく (8秒)
//  - TURBO:  ブースト無限 (6秒)
//  - SPRING: ジャンプ力2倍、3段ジャンプ可 (10秒)

const PowerUps = {
  TYPES: ['shield', 'magnet', 'giant', 'turbo', 'spring'],
  META: {
    shield: { color: 0x4fc3f7, icon: '🛡', label: 'SHIELD',   dur: 12 },
    magnet: { color: 0xab47bc, icon: '🧲', label: 'MAGNET',   dur: 10 },
    giant:  { color: 0xef5350, icon: '🦏', label: 'GIANT',    dur: 8  },
    turbo:  { color: 0xffeb3b, icon: '⚡', label: 'TURBO',    dur: 6  },
    spring: { color: 0x66bb6a, icon: '🪀', label: 'SPRING',   dur: 10 },
  },

  // フィールド上のボックス
  boxes: [],
  spawnTimer: 0,
  spawnInterval: 14, // 秒
  scene: null,
  enabled: true,

  init(scene) {
    this.scene = scene;
    this.boxes = [];
    this.spawnTimer = 6;
  },

  reset() {
    for (const b of this.boxes) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    }
    this.boxes = [];
    this.spawnTimer = 6;
  },

  update(dt) {
    if (!this.enabled || !this.scene) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.boxes.length < 3) {
      this._spawnBox();
      this.spawnTimer = this.spawnInterval + Math.random() * 6;
    }
    // ボックス回転＆浮遊
    const t = performance.now() / 600;
    for (const b of this.boxes) {
      b.mesh.rotation.y += dt * 1.6;
      b.mesh.rotation.x += dt * 0.6;
      b.mesh.position.y = b.baseY + Math.sin(t + b.phase) * 0.6;
    }
    // 車との接触判定 (ローカル車のみ取らせる: ホスト権威で全車判定)
    if (Net.peer && !Net.isHost) return; // クライアントは取らない
    for (const car of Game.cars.values()) {
      if (car.respawnTimer > 0) continue;
      for (let i = this.boxes.length - 1; i >= 0; i--) {
        const b = this.boxes[i];
        const dx = car.x - b.x, dz = car.z - b.z, dy = car.y - b.mesh.position.y;
        const d2 = dx*dx + dy*dy + dz*dz;
        const r = (CarPhys.RADIUS + 2.2);
        if (d2 < r * r) {
          this._collect(car, b);
          this._removeBox(i);
          // ネット同期 (ホスト)
          if (Net.peer && Net.isHost) {
            Net._broadcast({ type: 'powerupTaken', carId: car.id, kind: b.kind });
          }
        }
      }
    }
  },

  _spawnBox() {
    if (!this.scene) return;
    const kind = this.TYPES[Math.floor(Math.random() * this.TYPES.length)];
    const meta = this.META[kind];
    // ランダム位置 (中央寄り・ペナルティエリア外)
    const margin = 14;
    const x = (Math.random() - 0.5) * (Arena.W - margin * 2);
    const z = (Math.random() - 0.5) * (Arena.L * 0.6);
    const baseY = 3.5;
    // ボックスメッシュ: 透明な多面体 + アイコン
    const group = new THREE.Group();
    const boxGeo = new THREE.OctahedronGeometry(2.2, 0);
    const boxMat = new THREE.MeshLambertMaterial({
      color: meta.color, transparent: true, opacity: 0.78, emissive: meta.color, emissiveIntensity: 0.3,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    group.add(box);
    // 内側のグロー
    const innerGeo = new THREE.OctahedronGeometry(1.0, 0);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const inner = new THREE.Mesh(innerGeo, innerMat);
    group.add(inner);
    // アイコンスプライト
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = '90px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.icon, 64, 70);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.scale.set(3.5, 3.5, 1);
    sprite.position.set(0, 0, 0);
    group.add(sprite);

    group.position.set(x, baseY, z);
    this.scene.add(group);
    this.boxes.push({
      kind, x, z, baseY, phase: Math.random() * Math.PI * 2, mesh: group,
    });
  },

  _removeBox(idx) {
    const b = this.boxes[idx];
    if (!b) return;
    this.scene.remove(b.mesh);
    this.boxes.splice(idx, 1);
  },

  _collect(car, box) {
    const meta = this.META[box.kind];
    if (!meta) return;
    car.activePower = box.kind;
    car.powerTimer = meta.dur;
    SFX.boostPad(true);
    // 取得ローカルなら表示
    if (car === Game.localCar) {
      this._renderIndicator();
      showToast(`${meta.icon} ${meta.label} GET!`, 1400);
    }
    // パーティクル爆発
    Game._spawnHitParticles(box.x, box.mesh.position.y, box.z, 35);
  },

  // 取得タイマー減少 + 効果適用
  applyEffects(car, dt) {
    if (!car.activePower) return;
    car.powerTimer -= dt;
    const meta = this.META[car.activePower];
    if (car.powerTimer <= 0) {
      car.activePower = null;
      car.powerTimer = 0;
      // 巨大化解除
      if (car._giantScale) {
        car.mesh.scale.set(1, 1, 1);
        car._giantScale = false;
      }
      if (car === Game.localCar) this._renderIndicator();
      return;
    }
    // 効果ごとの実装
    switch (car.activePower) {
      case 'turbo':
        car.boost = Math.max(car.boost, 30);
        break;
      case 'giant':
        if (!car._giantScale) {
          car.mesh.scale.set(1.5, 1.5, 1.5);
          car._giantScale = true;
        }
        break;
      case 'magnet': {
        const ball = Game.ball;
        const dx = car.x - ball.x;
        const dy = (car.y + 2) - ball.y;
        const dz = car.z - ball.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < 30 && d > BallPhys.RADIUS + CarPhys.RADIUS + 0.5) {
          const f = Utils.clamp((30 - d) * 1.6, 0, 30);
          ball.vx += (dx / d) * f * dt;
          ball.vy += (dy / d) * f * dt;
          ball.vz += (dz / d) * f * dt;
        }
        break;
      }
      // shield / spring は他箇所で扱う
    }
  },

  // ローカル車の取得済みパワーをHUDに表示
  _renderIndicator() {
    const el = document.getElementById('powerup-indicator');
    if (!el || !Game.localCar) return;
    el.innerHTML = '';
    const p = Game.localCar.activePower;
    if (!p) return;
    const meta = this.META[p];
    const pill = document.createElement('div');
    pill.className = 'powerup-pill';
    pill.style.setProperty('--glow', `rgba(${this._hex2rgb(meta.color)},0.6)`);
    pill.style.borderColor = `#${meta.color.toString(16).padStart(6,'0')}`;
    pill.style.color = `#${meta.color.toString(16).padStart(6,'0')}`;
    pill.innerHTML = `${meta.icon} <span class="ptime">${Math.ceil(Game.localCar.powerTimer)}s</span>`;
    el.appendChild(pill);
  },

  _hex2rgb(h) {
    return [(h >> 16) & 255, (h >> 8) & 255, h & 255].join(',');
  },

  // 毎フレームHUD時間更新
  tickHUD() {
    const el = document.getElementById('powerup-indicator');
    if (!el || !Game.localCar) return;
    const span = el.querySelector('.ptime');
    if (span && Game.localCar.activePower) {
      span.textContent = `${Math.max(0, Game.localCar.powerTimer).toFixed(1)}s`;
    } else if (el.children.length > 0 && !Game.localCar.activePower) {
      el.innerHTML = '';
    }
  },
};

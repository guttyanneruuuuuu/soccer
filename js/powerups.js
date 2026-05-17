// ============= パワーアップシステム (オリジナル要素) =============
// PDCA7 改善:
//   - アイコンスプライトテクスチャをキャッシュ (毎回 canvas 生成しない → 軽量化)
//   - MAGNET の引き寄せ力を強化 (35m → 40m まで効果範囲拡大)
//   - SHIELD/MAGNET の可視オーラは car.js 側で実装 (常時アニメ)
//   - パワーアップ取得時に車を画面で見える発光リング (パーティクル爆発済み)
//   - turbo の効果は car.js 側で boost 燃料消費を止めるように修正
const PowerUps = {
  TYPES: ['shield', 'magnet', 'giant', 'turbo', 'spring'],
  META: {
    shield: { color: 0x4fc3f7, icon: '🛡', label: 'SHIELD',   dur: 12 },
    magnet: { color: 0xab47bc, icon: '🧲', label: 'MAGNET',   dur: 10 },
    giant:  { color: 0xef5350, icon: '🦏', label: 'GIANT',    dur: 8  },
    turbo:  { color: 0xffeb3b, icon: '⚡', label: 'TURBO',    dur: 6  },
    spring: { color: 0x66bb6a, icon: '🪀', label: 'SPRING',   dur: 10 },
  },

  boxes: [],
  spawnTimer: 0,
  spawnInterval: 11,
  maxBoxes: 4,
  scene: null,
  enabled: true,
  _iconTexCache: {}, // kind -> THREE.CanvasTexture (使い回し)

  init(scene) {
    this.scene = scene;
    this.boxes = [];
    this.spawnTimer = 6;
    // アイコンテクスチャを事前生成してキャッシュ
    for (const kind of this.TYPES) {
      this._iconTexCache[kind] = this._makeIconTex(this.META[kind].icon);
    }
  },

  _makeIconTex(icon) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = '90px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, 64, 70);
    return new THREE.CanvasTexture(c);
  },

  reset() {
    for (const b of this.boxes) this._disposeBox(b);
    this.boxes = [];
    this.spawnTimer = 6;
  },

  // Group の子 Mesh を再帰的に dispose
  _disposeBox(b) {
    if (!b || !b.mesh) return;
    if (this.scene) this.scene.remove(b.mesh);
    b.mesh.traverse((obj) => {
      if (obj.isMesh || obj.isSprite) {
        if (obj.geometry && obj.geometry.dispose) {
          try { obj.geometry.dispose(); } catch (_) {}
        }
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            // ※ アイコンテクスチャはキャッシュ。dispose しない
            if (m && m.dispose && !m._iconCached) {
              try { m.dispose(); } catch (_) {}
            }
          }
        }
      }
    });
  },

  update(dt) {
    if (!this.enabled || !this.scene) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.boxes.length < this.maxBoxes) {
      const box = this._spawnBox();
      this.spawnTimer = this.spawnInterval + Math.random() * 5;
      if (Net.peer && Net.isHost && box) {
        Net._broadcast({
          type: 'powerupSpawn',
          id: box.id, kind: box.kind, x: box.x, z: box.z, baseY: box.baseY, phase: box.phase,
        });
      }
    }
    const t = performance.now() / 600;
    for (const b of this.boxes) {
      b.mesh.rotation.y += dt * 1.6;
      b.mesh.rotation.x += dt * 0.6;
      b.mesh.position.y = b.baseY + Math.sin(t + b.phase) * 0.6;
    }
    // 車との接触判定: クライアントは取らない (ホスト権威)
    if (Net.peer && !Net.isHost) return;
    for (const car of Game.cars.values()) {
      if (car.respawnTimer > 0) continue;
      for (let i = this.boxes.length - 1; i >= 0; i--) {
        const b = this.boxes[i];
        const dx = car.x - b.x, dz = car.z - b.z, dy = car.y - b.mesh.position.y;
        const d2 = dx*dx + dy*dy + dz*dz;
        const r = (CarPhys.RADIUS + 2.2);
        if (d2 < r * r) {
          this._collect(car, b);
          const removedId = b.id;
          this._removeBox(i);
          if (Net.peer && Net.isHost) {
            Net._broadcast({ type: 'powerupTaken', carId: car.id, kind: b.kind, boxId: removedId });
          }
        }
      }
    }
  },

  applyRemoteSpawn(data) {
    if (Net.isHost || !this.scene) return;
    if (this.boxes.find(b => b.id === data.id)) return;
    this._buildBox(data.kind, data.x, data.z, data.baseY, data.phase, data.id);
  },

  applyRemoteTake(boxId) {
    if (Net.isHost) return;
    const idx = this.boxes.findIndex(b => b.id === boxId);
    if (idx >= 0) this._removeBox(idx);
  },

  _spawnBox() {
    if (!this.scene) return null;
    const kind = this.TYPES[Math.floor(Math.random() * this.TYPES.length)];
    const margin = 14;
    const x = (Math.random() - 0.5) * (Arena.W - margin * 2);
    const z = (Math.random() - 0.5) * (Arena.L * 0.6);
    const baseY = 3.5;
    const phase = Math.random() * Math.PI * 2;
    const id = 'pu_' + Math.random().toString(36).slice(2, 9);
    return this._buildBox(kind, x, z, baseY, phase, id);
  },

  _buildBox(kind, x, z, baseY, phase, id) {
    const meta = this.META[kind];
    if (!meta) return null;
    const group = new THREE.Group();
    const boxGeo = new THREE.OctahedronGeometry(2.2, 0);
    const boxMat = new THREE.MeshLambertMaterial({
      color: meta.color, transparent: true, opacity: 0.78, emissive: meta.color, emissiveIntensity: 0.3,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    group.add(box);
    const innerGeo = new THREE.OctahedronGeometry(1.0, 0);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const inner = new THREE.Mesh(innerGeo, innerMat);
    group.add(inner);
    // アイコンスプライト (キャッシュ済テクスチャ使用)
    const tex = this._iconTexCache[kind];
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    spriteMat._iconCached = true; // dispose 時に消さないマーク
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(3.5, 3.5, 1);
    group.add(sprite);

    group.position.set(x, baseY, z);
    this.scene.add(group);
    const obj = {
      id, kind, x, z, baseY, phase, mesh: group,
    };
    this.boxes.push(obj);
    return obj;
  },

  _removeBox(idx) {
    const b = this.boxes[idx];
    if (!b) return;
    this._disposeBox(b);
    this.boxes.splice(idx, 1);
  },

  _collect(car, box) {
    const meta = this.META[box.kind];
    if (!meta) return;
    car.activePower = box.kind;
    car.powerTimer = meta.dur;
    SFX.boostPad(true);
    SFX.powerup && SFX.powerup();
    if (car === Game.localCar) {
      this._renderIndicator();
      showToast(`${meta.icon} ${meta.label} GET!`, 1400);
      Game.addCamShake && Game.addCamShake(0.35);
    }
    Game._spawnHitParticles(box.x, box.mesh.position.y, box.z, 35);
  },

  // 取得タイマー減少 + 効果適用
  applyEffects(car, dt) {
    if (!car.activePower) return;
    car.powerTimer -= dt;
    if (car.powerTimer <= 0) {
      car.activePower = null;
      car.powerTimer = 0;
      if (car._giantScale) {
        car.mesh.scale.set(1, 1, 1);
        car._giantScale = false;
      }
      if (car === Game.localCar) this._renderIndicator();
      return;
    }
    switch (car.activePower) {
      case 'turbo':
        // 燃料を高速回復 (car.js 側のブースト消費を打ち消す)
        car.boost = Math.min(car.boostMax, Math.max(car.boost, 30) + 80 * dt);
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
        // 40m まで効果。引き寄せ力もUP
        if (d < 40 && d > BallPhys.RADIUS + CarPhys.RADIUS + 0.5) {
          const f = Utils.clamp((40 - d) * 1.9, 0, 38);
          ball.vx += (dx / d) * f * dt;
          ball.vy += (dy / d) * f * dt;
          ball.vz += (dz / d) * f * dt;
        }
        break;
      }
      // shield / spring は他箇所で扱う (シールドは _demolish 内、SPRING は car.js)
    }
  },

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

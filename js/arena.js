// ============= アリーナ（ロケットリーグ風サッカーフィールド） =============
// Z軸: 長辺(ゴール方向)。X軸: 短辺。Y軸: 上方向。
const Arena = {
  W: 80,           // 短辺(X) ハーフ幅 = 40
  L: 100,          // 長辺(Z) ハーフ長 = 50
  H: 40,           // 天井までの高さ
  GOAL_W: 24,      // ゴール幅
  GOAL_H: 12,      // ゴールの高さ
  GOAL_DEPTH: 6,   // ゴール奥行き
  WALL_BOUNCE: 0.85,
  CEIL_BOUNCE: 0.75,
  FLOOR_BOUNCE: 0.55,

  group: null,
  boostPads: [],   // {x, z, big, active, recoverAt, mesh}

  build(scene) {
    const g = new THREE.Group();
    this.group = g;

    // ===== フロア =====
    const floorGeo = new THREE.PlaneGeometry(this.W, this.L);
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x1f6b2a });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);

    // フィールドラインを上に描画
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    // 中央線
    const centerLine = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-this.W/2, 0.02, 0),
      new THREE.Vector3( this.W/2, 0.02, 0),
    ]);
    g.add(new THREE.Line(centerLine, lineMat));
    // センターサークル
    const circlePts = [];
    const cr = 12;
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      circlePts.push(new THREE.Vector3(Math.cos(t) * cr, 0.02, Math.sin(t) * cr));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts), lineMat));

    // ペナルティエリア (ゴール前)
    for (const sign of [-1, 1]) {
      const pa = [];
      const paW = this.GOAL_W + 10;
      const paD = 12;
      const z0 = sign * (this.L/2 - paD);
      const z1 = sign * (this.L/2);
      pa.push(new THREE.Vector3(-paW/2, 0.02, z0));
      pa.push(new THREE.Vector3( paW/2, 0.02, z0));
      pa.push(new THREE.Vector3( paW/2, 0.02, z1));
      pa.push(new THREE.Vector3(-paW/2, 0.02, z1));
      pa.push(new THREE.Vector3(-paW/2, 0.02, z0));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pa), lineMat));
    }

    // ===== 壁(透明感のあるグレー) =====
    const wallMat = new THREE.MeshLambertMaterial({
      color: 0x2a3b4d, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
    });
    // 長辺の壁（X = ±W/2）
    for (const sign of [-1, 1]) {
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(this.L, this.H),
        wallMat
      );
      wall.rotation.y = sign * Math.PI / 2;
      wall.position.set(sign * this.W/2, this.H/2, 0);
      g.add(wall);
    }
    // 短辺の壁（Z = ±L/2）ただしゴール部分は除く（簡易: 上下のフレームを追加）
    // 簡略化のため、ゴールの周囲のフレームを表現
    const frameMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const sign of [-1, 1]) {
      // 短辺の壁全体（ゴールは衝突判定側で除外）
      const back = new THREE.Mesh(
        new THREE.PlaneGeometry(this.W, this.H),
        wallMat.clone()
      );
      back.position.set(0, this.H/2, sign * this.L/2);
      if (sign === 1) back.rotation.y = Math.PI;
      g.add(back);

      // ゴール枠 (色分け: 青チーム=-Z側, オレンジ=+Z側)
      const teamColor = sign < 0 ? 0x29b6f6 : 0xff7043;
      const goalMat = new THREE.MeshLambertMaterial({ color: teamColor, transparent: true, opacity: 0.5 });
      const goalBox = new THREE.Mesh(
        new THREE.BoxGeometry(this.GOAL_W, this.GOAL_H, this.GOAL_DEPTH),
        goalMat
      );
      goalBox.position.set(0, this.GOAL_H/2, sign * (this.L/2 + this.GOAL_DEPTH/2 - 0.1));
      g.add(goalBox);
      // ゴール枠線
      const fr = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(this.GOAL_W, this.GOAL_H, this.GOAL_DEPTH)),
        new THREE.LineBasicMaterial({ color: 0xffffff })
      );
      fr.position.copy(goalBox.position);
      g.add(fr);
    }

    // ===== 天井 =====
    const ceilMat = new THREE.MeshLambertMaterial({
      color: 0x1a2530, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(this.W, this.L), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = this.H;
    g.add(ceil);

    // ===== ブーストパッド =====
    this.boostPads = [];
    const padPositions = [
      // 大(orange) - 4隅と中央サイド
      { x: -this.W/2 + 8, z: -this.L/2 + 8, big: true },
      { x:  this.W/2 - 8, z: -this.L/2 + 8, big: true },
      { x: -this.W/2 + 8, z:  this.L/2 - 8, big: true },
      { x:  this.W/2 - 8, z:  this.L/2 - 8, big: true },
      { x: -this.W/2 + 4, z: 0, big: true },
      { x:  this.W/2 - 4, z: 0, big: true },
      // 小(yellow) - 散らす
      { x: 0, z: -25, big: false },
      { x: 0, z:  25, big: false },
      { x: -18, z: -15, big: false },
      { x:  18, z: -15, big: false },
      { x: -18, z:  15, big: false },
      { x:  18, z:  15, big: false },
      { x: -10, z: 0, big: false },
      { x:  10, z: 0, big: false },
    ];
    for (const p of padPositions) {
      const r = p.big ? 2.4 : 1.3;
      const padGeo = new THREE.CircleGeometry(r, 16);
      const padMat = new THREE.MeshBasicMaterial({
        color: p.big ? 0xff8800 : 0xffff00, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      });
      const padMesh = new THREE.Mesh(padGeo, padMat);
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.position.set(p.x, 0.05, p.z);
      g.add(padMesh);
      this.boostPads.push({
        x: p.x, z: p.z, big: p.big, active: true, recoverAt: 0, mesh: padMesh,
      });
    }

    scene.add(g);
  },

  // ボール/車の壁衝突判定用ヘルパー
  // 矩形 [x:±W/2, z:±L/2], floor y=radius, ceiling y=H-radius
  // ゴール部分はZ方向の壁を抜けてゴールへ
  isInGoalArea(x, y, z, radius = 0) {
    const inX = Math.abs(x) <= this.GOAL_W / 2 - radius;
    const inY = y <= this.GOAL_H - radius;
    const inZ = Math.abs(z) >= this.L / 2 - radius;
    return inX && inY && inZ;
  },

  updatePads(dt, now) {
    for (const p of this.boostPads) {
      if (!p.active && now >= p.recoverAt) {
        p.active = true;
        p.mesh.material.opacity = 0.9;
      }
    }
  },

  consumePad(x, z) {
    for (const p of this.boostPads) {
      if (!p.active) continue;
      const dx = x - p.x, dz = z - p.z;
      const d2 = dx*dx + dz*dz;
      const r = p.big ? 2.6 : 1.5;
      if (d2 <= r * r) {
        p.active = false;
        p.mesh.material.opacity = 0.15;
        p.recoverAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + (p.big ? 10000 : 4000);
        return p.big ? 100 : 25;
      }
    }
    return 0;
  },
};

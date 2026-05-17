// ============= アリーナ（ロケットリーグ実寸を再現した広いフィールド） =============
// 公式 Rocket League のスタンダードフィールドは 102.4m × 81.92m × 20.48m。
// この実寸を踏襲しつつ、空中プレーが楽しめるよう天井を高めに 42m に設定。
// Z軸: 長辺(ゴール方向)。X軸: 短辺。Y軸: 上方向。
const ARENA_SCALE = 7.0;
const SUPER_JUMP_CENTER_RADIUS = 4.2;
const SUPER_JUMP_SIDE_RADIUS = 3.6;
const SUPER_JUMP_CENTER_MULT = 3.2;
const SUPER_JUMP_SIDE_MULT = 2.8;
const SUPER_JUMP_SIDE_OFFSET = 18;
const SUPER_JUMP_PULSE_SPEED = 220;
const SUPER_JUMP_PULSE_PHASE = 0.03;
const SUPER_JUMP_PULSE_AMPLITUDE = 0.1;
const SUPER_JUMP_BASE_OPACITY = 0.32;
const SUPER_JUMP_OPACITY_GAIN = 0.9;

const Arena = {
  SCALE: ARENA_SCALE,       // ユーザー要望: コートを約6倍へ
  W: 82 * ARENA_SCALE,            // 短辺(X) ハーフ幅 = 41
  L: 104 * ARENA_SCALE,           // 長辺(Z) ハーフ長 = 52
  H: 24 * ARENA_SCALE,            // 天井をさらに低くして空中戦を詰める
  GOAL_W: 26 * ARENA_SCALE,       // ゴール幅
  GOAL_H: 13 * ARENA_SCALE,       // ゴールの高さ
  GOAL_DEPTH: 8 * ARENA_SCALE,    // ゴール奥行き
  WALL_BOUNCE: 0.88,
  CEIL_BOUNCE: 0.78,
  FLOOR_BOUNCE: 0.55,
  CORNER_INSET: 12 * ARENA_SCALE, // コーナーを斜めにカットして丸い印象 (壁ライド演出)
  PAD_PICKUP_RADIUS_BIG: 3.6 * ARENA_SCALE,
  PAD_PICKUP_RADIUS_SMALL: 2.0 * ARENA_SCALE,

  group: null,
  boostPads: [],    // {x, z, big, active, recoverAt, mesh, ring}
  superJumpZones: [], // {x, z, radius, jumpMult, mesh, ring}
  cornerWalls: [],  // {p1, p2, normal} — 斜めコーナー壁の衝突ライン (XZ平面)
  EDGE_NORMAL_BLEND_DOT: 0.35, // dotが高い=最近点法線と内向き法線が近い(端点寄り)ため角として処理する

  build(scene) {
    const S = this.SCALE;
    const g = new THREE.Group();
    this.group = g;

    // ===== フロア =====
    // 芝の縞模様を作る
    const floorTex = this._makeFieldTexture();
    floorTex.anisotropy = 4;
    const floorGeo = new THREE.PlaneGeometry(this.W, this.L);
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);

    // フロアエッジに発光ライン (アリーナのフチ)
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.85 });
    const edgePts = [
      [-this.W/2, this.L/2], [this.W/2 - this.CORNER_INSET, this.L/2],
      [this.W/2, this.L/2 - this.CORNER_INSET], [this.W/2, -this.L/2 + this.CORNER_INSET],
      [this.W/2 - this.CORNER_INSET, -this.L/2], [-this.W/2 + this.CORNER_INSET, -this.L/2],
      [-this.W/2, -this.L/2 + this.CORNER_INSET], [-this.W/2, this.L/2 - this.CORNER_INSET],
      [-this.W/2 + this.CORNER_INSET, this.L/2],
    ];
    for (let i = 0; i < edgePts.length - 1; i++) {
      const [x1, z1] = edgePts[i];
      const [x2, z2] = edgePts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(len, 0.6 * S),
        edgeMat
      );
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = Math.atan2(z2 - z1, x2 - x1);
      stripe.position.set((x1 + x2) / 2, 0.12 * S, (z1 + z2) / 2);
      g.add(stripe);
    }

    // ===== フィールドライン =====
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
    // 中央線
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-this.W/2 + 0.5, 0.05, 0),
      new THREE.Vector3( this.W/2 - 0.5, 0.05, 0),
    ]), lineMat));
    // センターサークル
    const circlePts = [];
    const cr = 14 * S;
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      circlePts.push(new THREE.Vector3(Math.cos(t) * cr, 0.05, Math.sin(t) * cr));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts), lineMat));
    // センタースポット
    const spotPts = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      spotPts.push(new THREE.Vector3(Math.cos(t) * 1.4 * S, 0.06, Math.sin(t) * 1.4 * S));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(spotPts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })));

    // ペナルティエリア
    for (const sign of [-1, 1]) {
      const pa = [];
      const paW = this.GOAL_W + 14 * S;
      const paD = 16 * S;
      const z0 = sign * (this.L/2 - paD);
      const z1 = sign * (this.L/2 - 0.5);
      pa.push(new THREE.Vector3(-paW/2, 0.05, z0));
      pa.push(new THREE.Vector3( paW/2, 0.05, z0));
      pa.push(new THREE.Vector3( paW/2, 0.05, z1));
      pa.push(new THREE.Vector3(-paW/2, 0.05, z1));
      pa.push(new THREE.Vector3(-paW/2, 0.05, z0));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pa), lineMat));
      // ゴールエリア小
      const gaW = this.GOAL_W + 4 * S;
      const gaD = 6 * S;
      const z2 = sign * (this.L/2 - gaD);
      const z3 = sign * (this.L/2 - 0.5);
      const ga = [
        new THREE.Vector3(-gaW/2, 0.06, z2),
        new THREE.Vector3( gaW/2, 0.06, z2),
        new THREE.Vector3( gaW/2, 0.06, z3),
        new THREE.Vector3(-gaW/2, 0.06, z3),
        new THREE.Vector3(-gaW/2, 0.06, z2),
      ];
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ga), lineMat));
    }

    // ===== 壁: 4側壁 + 4コーナー（斜め） =====
    // 壁ライド感を出すため透けるグレー＆光のライン
    const wallMat = new THREE.MeshLambertMaterial({
      color: 0x1a2535, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
    });
    // 壁上部のネオンストリップ素材
    const neonBlueMat = new THREE.MeshBasicMaterial({ color: 0x29b6f6 });
    const neonOrgMat  = new THREE.MeshBasicMaterial({ color: 0xff7043 });
    // 長辺(X = ±W/2) 壁: コーナーinsetを差し引いた長さ
    const longSideLen = this.L - this.CORNER_INSET * 2;
    for (const sign of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(longSideLen, this.H), wallMat);
      wall.rotation.y = sign * Math.PI / 2;
      wall.position.set(sign * this.W/2, this.H/2, 0);
      g.add(wall);
    }
    // 短辺(Z = ±L/2) 壁: コーナーinsetを差し引いた幅
    const shortSideLen = this.W - this.CORNER_INSET * 2;
    for (const sign of [-1, 1]) {
      const back = new THREE.Mesh(new THREE.PlaneGeometry(shortSideLen, this.H), wallMat);
      back.position.set(0, this.H/2, sign * this.L/2);
      if (sign === 1) back.rotation.y = Math.PI;
      g.add(back);

      // 短辺壁にチームカラーの大型ネオンストライプ (上下2本)
      const teamMat = sign < 0 ? neonBlueMat : neonOrgMat;
      const stripe1 = new THREE.Mesh(new THREE.PlaneGeometry(shortSideLen, 0.6 * S), teamMat);
      stripe1.position.set(0, this.H - 1.5 * S, sign * (this.L/2 - 0.05));
      if (sign === 1) stripe1.rotation.y = Math.PI;
      g.add(stripe1);
      const stripe2 = new THREE.Mesh(new THREE.PlaneGeometry(shortSideLen, 0.4 * S), teamMat);
      stripe2.position.set(0, 2.5 * S, sign * (this.L/2 - 0.05));
      if (sign === 1) stripe2.rotation.y = Math.PI;
      g.add(stripe2);
    }

    // 長辺壁にも青/橙の交互ネオンライン (上部)
    for (const sign of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(longSideLen, 0.5 * S), 
        new THREE.MeshBasicMaterial({ color: 0x9c27b0 }));
      stripe.rotation.y = sign * Math.PI / 2;
      stripe.position.set(sign * (this.W/2 - 0.05), this.H - 2.5 * S, 0);
      g.add(stripe);
    }

    // 4 コーナー (斜め壁) - ロケットリーグ風の45度カットイン
    this.cornerWalls = [];
    const cw = this.CORNER_INSET * Math.SQRT2; // 斜め壁の幅
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cornerMesh = new THREE.Mesh(new THREE.PlaneGeometry(cw, this.H), wallMat);
        // 内向き法線。コーナーは45度傾けた壁
        const cx = sx * (this.W/2 - this.CORNER_INSET / 2);
        const cz = sz * (this.L/2 - this.CORNER_INSET / 2);
        // 壁の向き: 法線は (-sx, -sz) を正規化した内向き方向。
        // PlaneのデフォルトでXY向きなので、Y軸回転で内向きにする。
        const normalAngle = Math.atan2(-sx, -sz); // atan2(x,z)
        cornerMesh.rotation.y = normalAngle + Math.PI / 2;
        cornerMesh.position.set(cx, this.H/2, cz);
        g.add(cornerMesh);

        // 衝突用 2D ライン (XZ平面の線分): コーナーの両端の2点を持つ
        // 壁の端点
        const p1 = new THREE.Vector2(sx * this.W/2, sz * (this.L/2 - this.CORNER_INSET));
        const p2 = new THREE.Vector2(sx * (this.W/2 - this.CORNER_INSET), sz * this.L/2);
        // 法線は内向き
        const dx = p2.x - p1.x, dz = p2.y - p1.y;
        const len = Math.sqrt(dx*dx + dz*dz);
        // 線分の右側法線（インワード）
        let nx = -dz / len, nz = dx / len;
        // インワード判定: 法線方向に進んだ点が原点側に近づくべき
        const midX = (p1.x + p2.x) / 2, midZ = (p1.y + p2.y) / 2;
        const ox = midX + nx, oz = midZ + nz;
        if (Math.abs(ox) > Math.abs(midX) || Math.abs(oz) > Math.abs(midZ)) {
          nx = -nx; nz = -nz;
        }
        this.cornerWalls.push({
          p1, p2, nx, nz, len,
        });
      }
    }

    // ===== ゴール（透明な箱 + フレーム + ネット） =====
    for (const sign of [-1, 1]) {
      const teamColor = sign < 0 ? 0x29b6f6 : 0xff7043;
      const goalMat = new THREE.MeshLambertMaterial({
        color: teamColor, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
      });
      const goalBox = new THREE.Mesh(
        new THREE.BoxGeometry(this.GOAL_W, this.GOAL_H, this.GOAL_DEPTH),
        goalMat
      );
      goalBox.position.set(0, this.GOAL_H/2, sign * (this.L/2 + this.GOAL_DEPTH/2 - 0.05));
      g.add(goalBox);

      // ゴール枠 (白フレーム)
      const fr = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(this.GOAL_W, this.GOAL_H, this.GOAL_DEPTH)),
        new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })
      );
      fr.position.copy(goalBox.position);
      g.add(fr);

      // 内側のネット風メッシュ (背面 + 上面 + 横)
      const netMat = new THREE.MeshBasicMaterial({
        color: teamColor, transparent: true, opacity: 0.32, wireframe: true,
      });
      const netBack = new THREE.Mesh(new THREE.PlaneGeometry(this.GOAL_W, this.GOAL_H, 8, 4), netMat);
      netBack.position.set(0, this.GOAL_H/2, sign * (this.L/2 + this.GOAL_DEPTH - 0.1));
      if (sign === 1) netBack.rotation.y = Math.PI;
      g.add(netBack);

      // ゴールライン（床に光るライン）
      const glMat = new THREE.MeshBasicMaterial({ color: teamColor });
      const goalLine = new THREE.Mesh(
        new THREE.PlaneGeometry(this.GOAL_W, 0.6 * S),
        glMat
      );
      goalLine.rotation.x = -Math.PI / 2;
      goalLine.position.set(0, 0.07 * S, sign * this.L/2);
      g.add(goalLine);
    }

    // ===== 天井 =====
    const ceilMat = new THREE.MeshLambertMaterial({
      color: 0x14202d, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(this.W, this.L), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = this.H;
    g.add(ceil);

    // 天井のグリッド模様
    const grid = new THREE.GridHelper(Math.max(this.W, this.L), Math.max(16, Math.round(16 * S)), 0x4fc3f7, 0x4fc3f7);
    grid.position.y = this.H - 0.05;
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    g.add(grid);

    // ===== ブーストパッド（実物配置を再現: 大6 + 小28個） =====
    this.boostPads = [];
    const padPositions = [
      // 大(Big, 100%) - フィールド両側の中央(2) + 4コーナー手前(4)
      { x: -this.W/2 + 6 * S,  z: 0, big: true },
      { x:  this.W/2 - 6 * S,  z: 0, big: true },
      { x: -this.W/2 + 6 * S,  z: -this.L/2 + this.CORNER_INSET + 6 * S, big: true },
      { x:  this.W/2 - 6 * S,  z: -this.L/2 + this.CORNER_INSET + 6 * S, big: true },
      { x: -this.W/2 + 6 * S,  z:  this.L/2 - this.CORNER_INSET - 6 * S, big: true },
      { x:  this.W/2 - 6 * S,  z:  this.L/2 - this.CORNER_INSET - 6 * S, big: true },
    ];
    // 小(Small, 12%) - フィールド全体に散らす
    const smallGrid = [
      // センターライン上の左右
      [-12 * S, 0], [12 * S, 0],
      // セカンドゾーン
      [-26 * S, -18 * S], [-12 * S, -18 * S], [0, -18 * S], [12 * S, -18 * S], [26 * S, -18 * S],
      [-26 * S,  18 * S], [-12 * S,  18 * S], [0,  18 * S], [12 * S,  18 * S], [26 * S,  18 * S],
      // 自陣・敵陣 中盤
      [-22 * S, -34 * S], [0, -34 * S], [22 * S, -34 * S],
      [-22 * S,  34 * S], [0,  34 * S], [22 * S,  34 * S],
      // ペナルティエリア外
      [-30 * S, -42 * S], [30 * S, -42 * S],
      [-30 * S,  42 * S], [30 * S,  42 * S],
      // 縦長で散らす
      [0, -8 * S], [0, 8 * S],
      [-32 * S, 0], [32 * S, 0],
      [-18 * S, -8 * S], [18 * S, -8 * S], [-18 * S, 8 * S], [18 * S, 8 * S],
    ];
    for (const [x, z] of smallGrid) padPositions.push({ x, z, big: false });

    for (const p of padPositions) {
      const r = p.big ? 3.2 * S : 1.6 * S;
      const padGeo = new THREE.CircleGeometry(r, p.big ? 24 : 16);
      const padMat = new THREE.MeshBasicMaterial({
        color: p.big ? 0xff8800 : 0xffff66, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      });
      const padMesh = new THREE.Mesh(padGeo, padMat);
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.position.set(p.x, 0.08, p.z);
      g.add(padMesh);

      // リング (グロー風)
      const ringGeo = new THREE.RingGeometry(r * 1.1, r * 1.35, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: p.big ? 0xffaa33 : 0xffff99, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.09, p.z);
      g.add(ring);

      this.boostPads.push({
        x: p.x, z: p.z, big: p.big, active: true, recoverAt: 0, mesh: padMesh, ring,
      });
    }

    // ===== スーパージャンプゾーン =====
    this.superJumpZones = [];
    const jumpZones = [
      { x: 0, z: 0, radius: SUPER_JUMP_CENTER_RADIUS * S, jumpMult: SUPER_JUMP_CENTER_MULT },
      { x: -SUPER_JUMP_SIDE_OFFSET * S, z: 0, radius: SUPER_JUMP_SIDE_RADIUS * S, jumpMult: SUPER_JUMP_SIDE_MULT },
      { x:  SUPER_JUMP_SIDE_OFFSET * S, z: 0, radius: SUPER_JUMP_SIDE_RADIUS * S, jumpMult: SUPER_JUMP_SIDE_MULT },
    ];
    for (const jz of jumpZones) {
      const zoneMesh = new THREE.Mesh(
        new THREE.CircleGeometry(jz.radius, 28),
        new THREE.MeshBasicMaterial({
          color: 0x7c4dff, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
        })
      );
      zoneMesh.rotation.x = -Math.PI / 2;
      zoneMesh.position.set(jz.x, 0.1, jz.z);
      g.add(zoneMesh);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(jz.radius * 0.9, jz.radius * 1.15, 28),
        new THREE.MeshBasicMaterial({
          color: 0xb388ff, transparent: true, opacity: 0.72, side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(jz.x, 0.11, jz.z);
      g.add(ring);

      this.superJumpZones.push({ ...jz, mesh: zoneMesh, ring });
    }

    // ===== スカイドーム / 観客席表現 =====
    const skyGeo = new THREE.SphereGeometry(360 * S, 24, 12, 0, Math.PI*2, 0, Math.PI/2);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x1a3a6b, side: THREE.BackSide,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.y = -5 * S;
    g.add(sky);

    // 観客席(リング状の暗色ブロック)
    const standMat = new THREE.MeshLambertMaterial({ color: 0x1a2535 });
    const standGeo = new THREE.RingGeometry(80 * S, 200 * S, 32);
    const stand = new THREE.Mesh(standGeo, standMat);
    stand.rotation.x = -Math.PI / 2;
    stand.position.y = -0.5 * S;
    g.add(stand);

    scene.add(g);
  },

  // 芝の縞模様テクスチャ
  _makeFieldTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    // ベース緑
    ctx.fillStyle = '#1f6b2a';
    ctx.fillRect(0, 0, 512, 512);
    // 縦縞 (16本)
    for (let i = 0; i < 16; i++) {
      if (i % 2 === 0) ctx.fillStyle = '#256b30';
      else ctx.fillStyle = '#1c6328';
      ctx.fillRect(i * 32, 0, 32, 512);
    }
    // ノイズ
    for (let i = 0; i < 1200; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '40,90,40' : '20,60,25'}, 0.4)`;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  },

  // ゴール領域内かどうか
  isInGoalArea(x, y, z, radius = 0) {
    const inX = Math.abs(x) <= this.GOAL_W / 2 - radius;
    const inY = y <= this.GOAL_H - radius;
    const inZ = Math.abs(z) >= this.L / 2 - radius;
    return inX && inY && inZ;
  },

  // ゴール開口部に車/ボールがあるか (Z軸壁衝突除外用)
  isInGoalSlot(x, y, radius = 0) {
    return Math.abs(x) <= this.GOAL_W/2 - radius
        && y <= this.GOAL_H - radius;
  },

  updatePads(dt, now) {
    for (const p of this.boostPads) {
      if (!p.active && now >= p.recoverAt) {
        p.active = true;
        p.mesh.material.opacity = 0.85;
        p.ring.material.opacity = 0.6;
      }
      // パッドのパルス演出
      if (p.active && p.ring) {
        const pulse = 1 + Math.sin(now / 300 + p.x * 0.1) * 0.08;
        p.ring.scale.set(pulse, pulse, 1);
      }
    }
    for (const z of this.superJumpZones) {
      if (!z || !z.ring || !z.mesh) continue;
      const pulse = 1 + Math.sin(now / SUPER_JUMP_PULSE_SPEED + z.x * SUPER_JUMP_PULSE_PHASE + z.z * SUPER_JUMP_PULSE_PHASE) * SUPER_JUMP_PULSE_AMPLITUDE;
      z.ring.scale.set(pulse, pulse, 1);
      z.mesh.material.opacity = SUPER_JUMP_BASE_OPACITY + Math.max(0, pulse - 1) * SUPER_JUMP_OPACITY_GAIN;
    }
  },

  consumePad(x, z) {
    for (const p of this.boostPads) {
      if (!p.active) continue;
      const dx = x - p.x, dz = z - p.z;
      const d2 = dx*dx + dz*dz;
      const r = p.big ? this.PAD_PICKUP_RADIUS_BIG : this.PAD_PICKUP_RADIUS_SMALL;
      if (d2 <= r * r) {
        p.active = false;
        p.mesh.material.opacity = 0.18;
        p.ring.material.opacity = 0.15;
        p.recoverAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + (p.big ? 10000 : 4000);
        return p.big ? 100 : 12;
      }
    }
    return 0;
  },

  getJumpBoostAt(x, z) {
    let mult = 1;
    for (const jz of this.superJumpZones) {
      const dx = x - jz.x, dz = z - jz.z;
      if (dx * dx + dz * dz <= jz.radius * jz.radius) {
        if (jz.jumpMult > mult) mult = jz.jumpMult;
      }
    }
    return mult;
  },

  // コーナー壁(XZ斜め線)との衝突を解決する。
  // 円(x,z,r)とラインセグメント p1->p2 の最短距離が r 未満なら法線方向に押し戻し速度反射。
  resolveCornerCollision(obj, radius, restitution = 0.8) {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let pushed = false;
      for (const cw of this.cornerWalls) {
        const ax = obj.x - cw.p1.x;
        const az = obj.z - cw.p1.y;
        const bx = cw.p2.x - cw.p1.x;
        const bz = cw.p2.y - cw.p1.y;
        const t = Utils.clamp((ax * bx + az * bz) / (cw.len * cw.len), 0, 1);
        const px = cw.p1.x + bx * t;
        const pz = cw.p1.y + bz * t;
        const dx = obj.x - px;
        const dz = obj.z - pz;
        const dist2 = dx*dx + dz*dz;
        const d = Math.sqrt(dist2) || 0.0001;
        const signed = dx * cw.nx + dz * cw.nz;
        const faceOverlap = radius - signed; // 壁面を跨いだすり抜け用
        const pointOverlap = radius - d;     // 端点/角のめり込み用

        // すり抜け防止: 基本は壁内向き法線、端点寄りなら最近点法線で処理
        let nx = cw.nx, nz = cw.nz;
        let overlap = faceOverlap;
        if (d > 0.0001) {
          const ex = dx / d, ez = dz / d;
          const edgeDot = ex * cw.nx + ez * cw.nz;
          if (edgeDot > this.EDGE_NORMAL_BLEND_DOT) {
            nx = ex; nz = ez;
            overlap = pointOverlap;
          }
        }
        if (overlap <= 0) continue;

        obj.x += nx * overlap;
        obj.z += nz * overlap;
        const vDot = (obj.vx || 0) * nx + (obj.vz || 0) * nz;
        if (vDot < 0) {
          obj.vx -= (1 + restitution) * vDot * nx;
          obj.vz -= (1 + restitution) * vDot * nz;
        }
        hit = true;
        pushed = true;
      }
      if (!pushed) break;
    }
    return hit;
  },
};

// ============= 入力管理 (ジャイロ + タッチボタン) =============
// スマホ横画面でのジャイロ操作を最大限直感的にするための入力レイヤ。PDCA7 で
// 「もっと楽しく/操作しやすく」を目標に大規模リファクタしている。
//
// ボタン配置 (タッチ、横画面想定):
//   - 左下:   JUMP        (短押し = 通常ジャンプ。空中で再度押すとフリップ)
//   - 右下:   ACCEL       (前進アクセル)
//   - 左中:   AIR ROLL L  (空中で左ロール: 押している間ステア入力をロールに切替)
//   - 右中:   BOOST       (ブースト。長押しで燃料消費)
//   - 右上:   CAMERA      (カメラ視点切替: 通常 / ボール視点)
//   - 中央:   HANDBRAKE   (パウダースライド・ハンドブレーキ。短押しで横滑り)
//
// ジャイロ操作:
//   - 左右の傾き (gamma/beta) → ステアリング (画面回転を考慮)
//   - 端末を奥に倒す(=底面が前) → アクセル (オプション)
//   - 端末を手前に倒す(=底面が後ろ) → ブレーキ/バック (ヒステリシス付き)
//
// 主な改善点:
//   - 感度のクイックプリセット (LOW / MED / HIGH) を `setPreset()` で提供
//   - ステア入力の非線形化を見直し: 中央 0〜0.4 をマイルド、0.4〜1.0 を加速
//   - ジャイロ無効時のキーボードステアにもイージング (急に最大値にならない)
//   - 「両親指で操作」を前提に touch のマルチポインタ・ロストを強化
//   - ジャンプ入力に立ち上がりエッジ + 100ms クールダウン (連射チャタリング防止)
//   - ハンドブレーキ (パウダースライド) 入力を追加
//   - 画面ロックされた状態でのジャイロ基準値を「中央〜±15° の範囲で軟キャリブレ」
const Input = {
  // ====== 出力 (ゲームから読まれる) ======
  steer: 0,        // -1 .. 1 (左右ステア)
  pitch: 0,        // -1 .. 1 (前後傾)
  accel: false,    // ACCELボタン押下 or 強い前傾(オプション)
  brake: false,    // 手前に傾けるとON or BRAKEキー
  boost: false,    // BOOSTボタン押下 or オプションで強前傾
  jump: false,     // 押した瞬間1フレームだけ立つ (consumeJumpで消費)
  jumpHeld: false,
  airRoll: false,  // AIR ROLLボタン押下中 ⇒ ステア入力をロールに使う
  handbrake: false,// ハンドブレーキ (パウダースライド)
  cameraToggleRequest: false, // カメラ切替要求 (consume制)

  // ====== ジャイロ状態 ======
  gyroEnabled: false,
  gyroCalibrated: false,
  gyroBase: 0,
  pitchBase: 0,
  gyroRaw: 0,
  pitchRaw: 0,
  gyroLastSampleTime: 0,
  gyroSamples: [],
  pitchSamples: [],
  _smoothed: 0,
  _pitchSmoothed: 0,
  _gyroOrientHandler: null,
  _fallbackLandscapeSign: 1,
  _safeStorage: null,
  _lastOrientUpdateTime: 0, // ジャイロパケットが届いてない時の検出用

  // ====== 設定 (LocalStorage に保存) ======
  // sensitivity: ステアがフルになる傾き(度)。小さいほど敏感。
  sensitivity: 16,
  deadzone: 0.6,
  invert: false,
  pitchSensitivity: 18,
  pitchDeadzone: 4.0,
  brakeThreshold: 0.42,
  boostThreshold: 0.45,
  autoBoost: false,
  autoAccel: false,
  steerCurveExp: 1.4,

  // 感度プリセット
  PRESETS: {
    low:  { sensitivity: 26, curve: 1.7 },  // のんびり: 倒さないとフル切れない
    med:  { sensitivity: 18, curve: 1.45 }, // 標準
    high: { sensitivity: 12, curve: 1.25 }, // キビキビ: 軽い手首ひねりで切れる
  },

  _keys: {},
  _jumpEdgeCooldown: 0,

  init() {
    this._safeStorage = this._getStorage();
    const saved = parseFloat(this._storageGet('soccer-sensitivity'));
    if (!isNaN(saved) && saved > 5 && saved < 60) this.sensitivity = saved;
    if (this._storageGet('soccer-invert') === '1') this.invert = true;
    if (this._storageGet('soccer-autoboost') === '1') this.autoBoost = true;
    if (this._storageGet('soccer-autoaccel') === '1') this.autoAccel = true;
    const curve = parseFloat(this._storageGet('soccer-curve'));
    if (!isNaN(curve) && curve >= 1.0 && curve <= 2.0) this.steerCurveExp = curve;

    this._bindKeys();
    this._bindTouch();
    this._setupAutoCalibrate();
  },

  setCurve(v) {
    this.steerCurveExp = Utils.clamp(v, 1.0, 2.0);
    this._storageSet('soccer-curve', String(this.steerCurveExp));
  },

  setPreset(name) {
    const p = this.PRESETS[name];
    if (!p) return;
    this.setSensitivity(p.sensitivity);
    this.setCurve(p.curve);
    this._storageSet('soccer-preset', name);
  },

  _setupAutoCalibrate() {
    if (screen.orientation) {
      try {
        screen.orientation.addEventListener('change', () => this._resetGyroTracking());
      } catch (_) {}
    }
    window.addEventListener('orientationchange', () => this._resetGyroTracking());
  },

  _bindKeys() {
    // PC 用キーボード (デバッグ・PC ユーザー向け)
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this._keys[k] = true;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') {
        if (this._jumpEdgeCooldown <= 0) {
          this.jump = true;
          this._jumpEdgeCooldown = 0.1;
        }
        this.jumpHeld = true;
      }
      if (k === 'shift') this.boost = true;
      if (k === 'q' || k === 'l') this.airRoll = true;
      if (k === 'e' || k === 'h') this.handbrake = true;
      if (k === 'v') this.cameraToggleRequest = true;
    });
    window.addEventListener('keyup', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      this._keys[k] = false;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') this.jumpHeld = false;
      if (k === 'shift') this.boost = false;
      if (k === 'q' || k === 'l') this.airRoll = false;
      if (k === 'e' || k === 'h') this.handbrake = false;
    });
  },

  _updateFromKeys() {
    if (this.gyroEnabled) return;
    const keys = this._keys;
    const lr = (keys['arrowright'] || keys['d'] ? 1 : 0) + (keys['arrowleft'] || keys['a'] ? -1 : 0);
    this._keySteer = lr;
    this.brake = !!(keys['arrowdown'] || keys['s']);
    this.accel = !!(keys['arrowup'] || keys['w']);
  },
  _keyboardOverride() {
    const keys = this._keys;
    if (keys['arrowup'] || keys['w']) this.accel = true;
    if (keys['arrowdown'] || keys['s']) this.brake = true;
  },

  // ==== タッチボタン: 「押している間 ON」====
  _bindHoldButton(id, onPress, onRelease) {
    const el = document.getElementById(id);
    if (!el) return;
    // 複数同時タッチ対応: 各ボタンに紐づくpointerIdセット
    const activePointers = new Set();
    const on = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.pointerId != null) activePointers.add(e.pointerId);
      el.classList.add('pressed');
      onPress && onPress();
    };
    const off = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.pointerId != null) activePointers.delete(e.pointerId);
      // ポインタが全部離れたら off
      if (activePointers.size === 0) {
        el.classList.remove('pressed');
        onRelease && onRelease();
      }
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('touchcancel', off, { passive: false });
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  // 「押した瞬間トリガー」ボタン (再エッジ検出はクールダウン付き)
  _bindTapButton(id, onTap) {
    const el = document.getElementById(id);
    if (!el) return;
    const handle = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      el.classList.add('pressed');
      onTap && onTap();
      setTimeout(() => el.classList.remove('pressed'), 100);
    };
    el.addEventListener('pointerdown', handle);
    el.addEventListener('touchstart', handle, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  _bindTouch() {
    // JUMP ボタン: タップで1度トリガー + ホールド検知 + チャタリング防止
    const jumpBtn = document.getElementById('ctrl-jump');
    if (jumpBtn) {
      const activePointers = new Set();
      const on = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.pointerId != null) activePointers.add(e.pointerId);
        if (this._jumpEdgeCooldown <= 0) {
          this.jump = true;
          this._jumpEdgeCooldown = 0.1;
        }
        this.jumpHeld = true;
        jumpBtn.classList.add('pressed');
      };
      const off = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.pointerId != null) activePointers.delete(e.pointerId);
        if (activePointers.size === 0) {
          this.jumpHeld = false;
          jumpBtn.classList.remove('pressed');
        }
      };
      jumpBtn.addEventListener('pointerdown', on);
      jumpBtn.addEventListener('pointerup', off);
      jumpBtn.addEventListener('pointercancel', off);
      jumpBtn.addEventListener('pointerleave', off);
      jumpBtn.addEventListener('touchstart', on, { passive: false });
      jumpBtn.addEventListener('touchend', off, { passive: false });
      jumpBtn.addEventListener('touchcancel', off, { passive: false });
      jumpBtn.addEventListener('mousedown', on);
      jumpBtn.addEventListener('mouseup', off);
      jumpBtn.addEventListener('mouseleave', off);
      jumpBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this._bindHoldButton('ctrl-accel', () => { this.accel = true; }, () => { this.accel = false; });
    this._bindHoldButton('ctrl-boost', () => { this.boost = true; }, () => { this.boost = false; });
    this._bindHoldButton('ctrl-airroll', () => { this.airRoll = true; }, () => { this.airRoll = false; });
    this._bindHoldButton('ctrl-handbrake', () => { this.handbrake = true; }, () => { this.handbrake = false; });
    this._bindTapButton('btn-camera', () => { this.cameraToggleRequest = true; });
  },

  // === メインループから毎フレーム呼ばれる ===
  update(dt) {
    if (this._jumpEdgeCooldown > 0) this._jumpEdgeCooldown -= dt;
    if (this.gyroEnabled) {
      const now = performance.now();
      if (this._lastOrientUpdateTime && now - this._lastOrientUpdateTime > 500) {
        // ジャイロデータが暫く来てない → 0 へ徐々に戻す (フリーズ防止)
        this._smoothed = Utils.lerp(this._smoothed, 0, dt * 4);
        this._pitchSmoothed = Utils.lerp(this._pitchSmoothed, 0, dt * 4);
        this.steer = this._smoothed;
        this.pitch = this._pitchSmoothed;
      }
      // PC キーボードでも accel/brake をオーバーライド (デバッグ用)
      this._keyboardOverride();
    } else {
      // ジャイロ無効ならキーボード steer をスムージング
      const target = this._keySteer || 0;
      const response = target === 0 ? 22 : 18;
      const alpha = Utils.clamp(dt * response, 0.28, 0.85);
      this.steer = Utils.lerp(this.steer, target, alpha);
      if (Math.abs(this.steer) < 0.001 && target === 0) this.steer = 0;
    }
  },

  consumeJump() {
    const v = this.jump;
    this.jump = false;
    return v;
  },

  consumeCameraToggle() {
    const v = this.cameraToggleRequest;
    this.cameraToggleRequest = false;
    return v;
  },

  async enableGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      } catch (e) {
        console.warn('gyro permission error', e);
        return false;
      }
    }
    if (!this._gyroOrientHandler) this._gyroOrientHandler = this._onOrient.bind(this);
    window.removeEventListener('deviceorientation', this._gyroOrientHandler);
    window.addEventListener('deviceorientation', this._gyroOrientHandler);
    this.gyroEnabled = true;
    this._resetGyroTracking();
    return true;
  },

  _onOrient(e) {
    this._lastOrientUpdateTime = performance.now();
    let g = e.gamma || 0;
    let b = e.beta || 0;
    let angle = 0;
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      angle = screen.orientation.angle;
    } else {
      angle = window.orientation || 0;
    }
    const normAngle = ((angle % 360) + 360) % 360;
    const orientationType = (screen.orientation && screen.orientation.type) ? screen.orientation.type : '';
    const fallbackLandscape = normAngle !== 90 && normAngle !== 270 &&
      ((orientationType && orientationType.startsWith('landscape')) || window.innerWidth > window.innerHeight);

    let mappedAngle = normAngle;
    if (fallbackLandscape) {
      if (orientationType.includes('secondary')) this._fallbackLandscapeSign = -1;
      else if (orientationType.includes('primary')) this._fallbackLandscapeSign = 1;
      else if (Math.abs(g) > 8) this._fallbackLandscapeSign = g >= 0 ? 1 : -1;
      mappedAngle = this._fallbackLandscapeSign > 0 ? 90 : 270;
    }
    const rad = mappedAngle * Math.PI / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    const steerVal = g * cosA + b * sinA;
    const pitchVal = -g * sinA + b * cosA;

    this.gyroRaw = steerVal;
    this.pitchRaw = pitchVal;

    // 自動キャリブレーション (両軸)
    if (!this.gyroCalibrated) {
      this.gyroSamples.push(steerVal);
      this.pitchSamples.push(pitchVal);
      if (this.gyroSamples.length >= 16) {
        let avg = 0, pavg = 0;
        for (let i = 0; i < this.gyroSamples.length; i++) {
          avg += this.gyroSamples[i];
          pavg += this.pitchSamples[i];
        }
        this.gyroBase = avg / this.gyroSamples.length;
        this.pitchBase = pavg / this.pitchSamples.length;
        this.gyroCalibrated = true;
        this.gyroSamples = [];
        this.pitchSamples = [];
      } else {
        this.gyroBase = steerVal;
        this.pitchBase = pitchVal;
      }
    }

    // ===== ステアリング =====
    let diff = steerVal - this.gyroBase;
    // 微弱ドリフト追従 (端末がだんだんずれる対策)
    if (this.gyroCalibrated && Math.abs(diff) < this.deadzone * 1.6) {
      this.gyroBase = Utils.lerp(this.gyroBase, steerVal, 0.005);
      diff = steerVal - this.gyroBase;
    }
    if (Math.abs(diff) < this.deadzone) diff = 0;
    else diff -= Math.sign(diff) * this.deadzone;
    const norm = Utils.clamp(diff / this.sensitivity, -1.2, 1.2);
    const absNorm = Math.min(1, Math.abs(norm));
    // 二段カーブ: 0〜0.4 はかなりマイルド、0.4〜1.0 で加速して切る
    let curved;
    if (absNorm < 0.4) {
      curved = Math.sign(norm) * Math.pow(absNorm / 0.4, this.steerCurveExp) * 0.4;
    } else {
      const t = (absNorm - 0.4) / 0.6;
      curved = Math.sign(norm) * (0.4 + Math.pow(t, 0.85) * 0.6);
    }
    let target = -Utils.clamp(curved, -1, 1);
    if (this.invert) target = -target;

    // ===== ピッチ =====
    let pdiff = pitchVal - this.pitchBase;
    if (this.gyroCalibrated && Math.abs(pdiff) < this.pitchDeadzone * 1.2) {
      this.pitchBase = Utils.lerp(this.pitchBase, pitchVal, 0.003);
      pdiff = pitchVal - this.pitchBase;
    }
    if (Math.abs(pdiff) < this.pitchDeadzone) pdiff = 0;
    else pdiff -= Math.sign(pdiff) * this.pitchDeadzone;
    const pnorm = Utils.clamp(pdiff / this.pitchSensitivity, -1.2, 1.2);
    const pcurved = Math.sign(pnorm) * Math.pow(Math.min(1, Math.abs(pnorm)), 1.2);
    const ptarget = Utils.clamp(pcurved, -1, 1);

    // 適応的ローパス: dt と変化量で動的に alpha 決定
    const now = performance.now();
    const dt = this.gyroLastSampleTime ? (now - this.gyroLastSampleTime) / 1000 : 0.016;
    this.gyroLastSampleTime = now;
    const delta = Math.abs(target - this._smoothed);
    const alpha = Utils.clamp(dt * (32 + delta * 38), 0.36, 0.94);
    this._smoothed = Utils.lerp(this._smoothed, target, alpha);
    this._pitchSmoothed = Utils.lerp(this._pitchSmoothed, ptarget, alpha * 0.85);

    this.steer = this._smoothed;
    this.pitch = this._pitchSmoothed;

    // ピッチ後傾でブレーキ (ヒステリシス付き)
    if (this.brake) {
      this.brake = (this.pitch > this.brakeThreshold * 0.62);
    } else {
      this.brake = (this.pitch > this.brakeThreshold);
    }
    // 前傾でブースト (オプション)
    if (this.autoBoost) {
      if (this.pitch < -this.boostThreshold) {
        this.boost = true;
      }
    }
    // 前傾でアクセル (オプション)
    if (this.autoAccel && this.pitch < -0.2) {
      this.accel = true;
    }
  },

  recalibrate() { this._resetGyroTracking(); },

  _resetGyroTracking() {
    this.gyroCalibrated = false;
    this.gyroSamples = [];
    this.pitchSamples = [];
    this.gyroLastSampleTime = 0;
    this._smoothed = 0;
    this._pitchSmoothed = 0;
    this._fallbackLandscapeSign = 1;
  },

  setSensitivity(deg) {
    this.sensitivity = Utils.clamp(deg, 6, 50);
    this._storageSet('soccer-sensitivity', String(this.sensitivity));
  },

  setInvert(v) {
    this.invert = !!v;
    this._storageSet('soccer-invert', this.invert ? '1' : '0');
  },

  setAutoBoost(v) {
    this.autoBoost = !!v;
    this._storageSet('soccer-autoboost', this.autoBoost ? '1' : '0');
  },

  setAutoAccel(v) {
    this.autoAccel = !!v;
    this._storageSet('soccer-autoaccel', this.autoAccel ? '1' : '0');
  },

  _getStorage() {
    try { return window.localStorage; } catch (_) { return null; }
  },
  _storageGet(key) {
    try { return this._safeStorage ? this._safeStorage.getItem(key) : null; } catch (_) { return null; }
  },
  _storageSet(key, value) {
    try { if (this._safeStorage) this._safeStorage.setItem(key, value); } catch (_) {}
  },
};

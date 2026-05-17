// ============= 入力管理 (ジャイロ + ACCEL/JUMP タッチ) =============
// racegame のジャイロ実装をベースに、サッカーゲーム用に再構成:
// - 左右ステアリング: ジャイロの傾き (gamma / beta) を自動キャリブレーション付きで使用
// - アクセル: 画面右下 ACCEL ボタン押下中のみ ON
// - ブレーキ/バック: 端末を奥(手前)に傾けるとピッチで発動 - ジャイロのみで操作!
// - ブースト: 端末を強めに前傾 (オプション) または Shift
// - ジャンプ: 画面のジャンプボタン (押した瞬間のみ true)
const Input = {
  // 出力
  steer: 0,       // -1 .. 1 (ジャイロ左右)
  pitch: 0,       // -1 .. 1 (ジャイロ前後傾)
  accel: false,   // ACCELボタン押下時 ON
  brake: false,   // ピッチ後傾 (端末を起こす)
  boost: false,   // ピッチ前傾 (端末を前に倒す) で発動
  jump: false,    // 1フレームだけ立つトリガー
  jumpHeld: false,

  gyroEnabled: false,
  gyroCalibrated: false,
  gyroBase: 0,      // ステアリング(横軸)基準
  pitchBase: 0,     // ピッチ(縦軸)基準
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

  // 設定値 (ジャイロ安定化)
  sensitivity: 12,
  deadzone: 1.2,
  invert: false,
  pitchSensitivity: 16,
  pitchDeadzone: 2.8,
  brakeThreshold: 0.3,
  boostThreshold: 0.34,
  autoBoost: false,        // 前傾でブーストするか (デフォルトOFF)

  _keys: {},

  init() {
    this._safeStorage = this._getStorage();
    const saved = parseFloat(this._storageGet('soccer-sensitivity'));
    if (!isNaN(saved) && saved > 5 && saved < 60) this.sensitivity = saved;
    const invSaved = this._storageGet('soccer-invert');
    if (invSaved === '1') this.invert = true;
    const ab = this._storageGet('soccer-autoboost');
    if (ab === '1') this.autoBoost = true;

    this._bindKeys();
    this._bindTouch();
    this._setupAutoCalibrate();
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
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this._keys[k] = true;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') { this.jump = true; this.jumpHeld = true; }
      if (k === 'shift') this.boost = true;
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this._keys[k] = false;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') this.jumpHeld = false;
      if (k === 'shift') this.boost = false;
    });
  },

  _updateFromKeys() {
    // ジャイロが無効なときに限り、キーボードでステア + ブレーキできる
    if (this.gyroEnabled) return;
    const keys = this._keys;
    const lr = (keys['arrowright'] || keys['d'] ? 1 : 0) + (keys['arrowleft'] || keys['a'] ? -1 : 0);
    this._keySteer = lr;
    this.brake = !!(keys['arrowdown'] || keys['s']);
    this.accel = !!(keys['arrowup'] || keys['w']);
  },

  _bindTouch() {
    // ジャンプボタンのみ
    const jumpBtn = document.getElementById('ctrl-jump');
    if (jumpBtn) {
      const on = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.jump = true;
        this.jumpHeld = true;
        jumpBtn.classList.add('pressed');
      };
      const off = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.jumpHeld = false;
        jumpBtn.classList.remove('pressed');
      };
      jumpBtn.addEventListener('touchstart', on, { passive: false });
      jumpBtn.addEventListener('touchend', off, { passive: false });
      jumpBtn.addEventListener('touchcancel', off, { passive: false });
      jumpBtn.addEventListener('mousedown', on);
      jumpBtn.addEventListener('mouseup', off);
      jumpBtn.addEventListener('mouseleave', off);
    }

    // アクセルボタン
    const accelBtn = document.getElementById('ctrl-accel');
    if (accelBtn) {
      const on = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.accel = true;
        accelBtn.classList.add('pressed');
      };
      const off = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.accel = false;
        accelBtn.classList.remove('pressed');
      };
      accelBtn.addEventListener('touchstart', on, { passive: false });
      accelBtn.addEventListener('touchend', off, { passive: false });
      accelBtn.addEventListener('touchcancel', off, { passive: false });
      accelBtn.addEventListener('mousedown', on);
      accelBtn.addEventListener('mouseup', off);
      accelBtn.addEventListener('mouseleave', off);
    }
  },

  update(dt) {
    // ジャイロが無効なら キーボード steer をスムージング
    if (!this.gyroEnabled) {
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

    // ステア用/ピッチ用を画面回転に追従して算出（直感操作重視）
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
      // 16サンプルで初期姿勢を平均化し、端末ごとのセンサーノイズ差を吸収
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
    // 微弱ドリフト追従
    if (this.gyroCalibrated && Math.abs(diff) < this.deadzone * 2.3) {
      this.gyroBase = Utils.lerp(this.gyroBase, steerVal, 0.009);
      diff = steerVal - this.gyroBase;
    }
    if (Math.abs(diff) < this.deadzone) diff = 0;
    else diff -= Math.sign(diff) * this.deadzone;
    const norm = Utils.clamp(diff / this.sensitivity, -1.2, 1.2);
    const curved = Math.sign(norm) * Math.pow(Math.min(1, Math.abs(norm)), 1.10);
    let target = -Utils.clamp(curved, -1, 1);
    if (this.invert) target = -target;

    // ===== ピッチ (ブレーキ/ブースト判定) =====
    let pdiff = pitchVal - this.pitchBase;
    // ピッチ基準はゆっくり追従するがステアより遅め
    if (this.gyroCalibrated && Math.abs(pdiff) < this.pitchDeadzone * 1.4) {
      this.pitchBase = Utils.lerp(this.pitchBase, pitchVal, 0.0045);
      pdiff = pitchVal - this.pitchBase;
    }
    if (Math.abs(pdiff) < this.pitchDeadzone) pdiff = 0;
    else pdiff -= Math.sign(pdiff) * this.pitchDeadzone;
    const pnorm = Utils.clamp(pdiff / this.pitchSensitivity, -1.2, 1.2);
    const pcurved = Math.sign(pnorm) * Math.pow(Math.min(1, Math.abs(pnorm)), 1.05);
    const ptarget = Utils.clamp(pcurved, -1, 1);

    // ローパスフィルタ (初動を速めつつノイズは抑える)
    const now = performance.now();
    const dt = this.gyroLastSampleTime ? (now - this.gyroLastSampleTime) / 1000 : 0.016;
    this.gyroLastSampleTime = now;
    const alpha = Utils.clamp(dt * 30, 0.35, 0.82);
    this._smoothed = Utils.lerp(this._smoothed, target, alpha);
    this._pitchSmoothed = Utils.lerp(this._pitchSmoothed, ptarget, alpha);

    this.steer = this._smoothed;
    this.pitch = this._pitchSmoothed;

    // ピッチ後傾 (端末を起こす方向: pitch > 0) でブレーキ
    this.brake = (this.pitch > this.brakeThreshold);
    // ピッチ前傾 でオプションブースト (デフォルト OFF。ジャンプボタンで集中。ブーストボタンが優先)
    if (this.autoBoost && !this._keys['shift']) {
      this.boost = (this.pitch < -this.boostThreshold);
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

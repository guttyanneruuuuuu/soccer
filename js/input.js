// ============= 入力管理 (ジャイロ + タッチ + キーボード) =============
// racegameのジャイロ実装をベースに、サッカーゲーム用に再構成
const Input = {
  steer: 0,
  accel: false,
  brake: false,
  boost: false,
  jump: false,           // 1フレームだけ立つトリガー
  jumpHeld: false,
  drift: false,

  gyroEnabled: false,
  gyroCalibrated: false,
  gyroBase: 0,
  gyroRaw: 0,
  gyroLastSampleTime: 0,
  gyroSamples: [],
  _smoothed: 0,
  _gyroOrientHandler: null,
  _fallbackLandscapeSign: 1,
  _safeStorage: null,

  // ジャイロ感度
  sensitivity: 18,
  deadzone: 1.5,
  invert: false,

  _keys: {},
  _keySteer: 0,
  _touchSteer: 0,
  _touchSteerActive: false,

  init() {
    this._safeStorage = this._getStorage();
    const saved = parseFloat(this._storageGet('soccer-sensitivity'));
    if (!isNaN(saved) && saved > 5 && saved < 60) this.sensitivity = saved;
    const invSaved = this._storageGet('soccer-invert');
    if (invSaved === '1') this.invert = true;

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
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this._keys[k] = true;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') {
        this.jump = true;
        this.jumpHeld = true;
      }
      if (k === 'shift') this.boost = true;
      if (k === 'x' || k === 'k') this.drift = true;
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this._keys[k] = false;
      this._updateFromKeys();
      if (k === ' ' || k === 'j') this.jumpHeld = false;
      if (k === 'shift') this.boost = false;
      if (k === 'x' || k === 'k') this.drift = false;
    });
  },

  _updateFromKeys() {
    const keys = this._keys;
    if (!this.gyroEnabled && !this._touchSteerActive) {
      this._keySteer = (keys['arrowright'] || keys['d'] ? 1 : 0) + (keys['arrowleft'] || keys['a'] ? -1 : 0);
    }
    this.accel = !!(keys['arrowup'] || keys['w']);
    this.brake = !!(keys['arrowdown'] || keys['s']);
  },

  _bindTouch() {
    const setHoldBtn = (id, prop, cls = 'pressed') => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const on = (e) => { e.preventDefault(); this[prop] = true; btn.classList.add(cls); };
      const off = (e) => { if (e) e.preventDefault(); this[prop] = false; btn.classList.remove(cls); };
      btn.addEventListener('touchstart', on, { passive: false });
      btn.addEventListener('touchend', off, { passive: false });
      btn.addEventListener('touchcancel', off, { passive: false });
      btn.addEventListener('mousedown', on);
      btn.addEventListener('mouseup', off);
      btn.addEventListener('mouseleave', off);
    };
    setHoldBtn('ctrl-accel', 'accel');
    setHoldBtn('ctrl-brake', 'brake');
    setHoldBtn('ctrl-boost', 'boost');
    setHoldBtn('ctrl-drift', 'drift');

    // ジャンプ: 押された瞬間にフラグを立てる
    const jumpBtn = document.getElementById('ctrl-jump');
    if (jumpBtn) {
      const on = (e) => {
        e.preventDefault();
        this.jump = true;
        this.jumpHeld = true;
        jumpBtn.classList.add('pressed');
      };
      const off = (e) => {
        if (e) e.preventDefault();
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
  },

  update(dt) {
    if (this.gyroEnabled) return;
    const target = this._touchSteerActive ? this._touchSteer : this._keySteer;
    const response = target === 0 ? 22 : 18;
    const alpha = Utils.clamp(dt * response, 0.28, 0.85);
    this.steer = Utils.lerp(this.steer, target, alpha);
    if (Math.abs(this.steer) < 0.001 && target === 0) this.steer = 0;
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

    let val;
    if (normAngle === 90) {
      val = b;
    } else if (normAngle === 270) {
      val = -b;
    } else if (fallbackLandscape) {
      if (orientationType.includes('secondary')) this._fallbackLandscapeSign = -1;
      else if (orientationType.includes('primary')) this._fallbackLandscapeSign = 1;
      else if (Math.abs(g) > 8) this._fallbackLandscapeSign = g >= 0 ? 1 : -1;
      val = b * this._fallbackLandscapeSign;
    } else {
      val = g;
    }

    this.gyroRaw = val;

    if (!this.gyroCalibrated) {
      this.gyroSamples.push(val);
      if (this.gyroSamples.length >= 20) {
        let avg = 0;
        for (const s of this.gyroSamples) avg += s;
        this.gyroBase = avg / this.gyroSamples.length;
        this.gyroCalibrated = true;
        this.gyroSamples = [];
      } else {
        this.gyroBase = val;
      }
    }

    let diff = val - this.gyroBase;
    if (this.gyroCalibrated && Math.abs(diff) < this.deadzone * 2.5) {
      this.gyroBase = Utils.lerp(this.gyroBase, val, 0.015);
      diff = val - this.gyroBase;
    }
    if (Math.abs(diff) < this.deadzone) diff = 0;
    else diff -= Math.sign(diff) * this.deadzone;

    const norm = Utils.clamp(diff / this.sensitivity, -1.2, 1.2);
    const curved = Math.sign(norm) * Math.pow(Math.min(1, Math.abs(norm)), 1.30);
    let target = -Utils.clamp(curved, -1, 1);
    if (this.invert) target = -target;

    const now = performance.now();
    const dt = this.gyroLastSampleTime ? (now - this.gyroLastSampleTime) / 1000 : 0.016;
    this.gyroLastSampleTime = now;
    const alpha = Utils.clamp(dt * 18, 0.25, 0.65);
    this._smoothed = Utils.lerp(this._smoothed, target, alpha);
    this.steer = this._smoothed;
  },

  recalibrate() { this._resetGyroTracking(); },

  _resetGyroTracking() {
    this.gyroCalibrated = false;
    this.gyroSamples = [];
    this.gyroLastSampleTime = 0;
    this._smoothed = 0;
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

// ============= 効果音 (Web Audio API でランタイム生成) =============
// PDCA7 改善:
//   - マスターボリュームを設定可能化 (LocalStorage 保存)
//   - powerup 取得・ハンドブレーキ・コンボ大成功 などの新SFX
//   - ctx が suspended のまま再開しないバグ対策 (visibility 変化でも resume)
const SFX = {
  ctx: null,
  master: null,
  enabled: true,
  _muted: false,
  _volume: 0.45,

  init() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      // 保存ボリュームを復元
      try {
        const v = parseFloat(localStorage.getItem('soccer-volume'));
        if (!isNaN(v) && v >= 0 && v <= 1) this._volume = v;
        if (localStorage.getItem('soccer-muted') === '1') this._muted = true;
      } catch (_) {}
      this.master.gain.value = this._muted ? 0 : this._volume;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      console.warn('audio init failed', e);
    }
    const resume = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('touchstart', resume, { once: false, passive: true });
    window.addEventListener('mousedown', resume, { once: false });
    window.addEventListener('keydown', resume, { once: false });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resume();
    });
  },

  mute(v) {
    this._muted = !!v;
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
    try { localStorage.setItem('soccer-muted', this._muted ? '1' : '0'); } catch (_) {}
  },

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.master && !this._muted) this.master.gain.value = this._volume;
    try { localStorage.setItem('soccer-volume', String(this._volume)); } catch (_) {}
  },

  getVolume() { return this._volume; },
  isMuted() { return this._muted; },

  _osc(type, freq, dur, gain = 0.4, attack = 0.01, release = 0.1, freqEnd = null) {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (freqEnd != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), ctx.currentTime + dur);
    }
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur + release);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + dur + release);
  },

  _noise(dur, gain = 0.2, filterFreq = 800) {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
  },

  ballHit(power = 0.5) {
    const p = Utils.clamp(power, 0, 1);
    this._osc('square', 200 + p * 220, 0.08, 0.18 + p * 0.2, 0.005, 0.05, 80);
    this._noise(0.12, 0.16 + p * 0.18, 1500 + p * 1500);
  },
  ballSmash(power = 1) {
    this._osc('sawtooth', 320, 0.16, 0.32, 0.008, 0.1, 60);
    this._noise(0.22, 0.32, 2400);
  },
  jump() {
    this._osc('triangle', 480, 0.13, 0.22, 0.005, 0.04, 820);
  },
  doubleJump() {
    this._osc('triangle', 720, 0.16, 0.22, 0.005, 0.05, 1100);
  },
  boostPad(big = false) {
    if (big) {
      this._osc('sawtooth', 220, 0.18, 0.22, 0.008, 0.1, 880);
      this._osc('square', 660, 0.12, 0.12, 0.01, 0.06, 1320);
    } else {
      this._osc('sine', 880, 0.08, 0.16, 0.005, 0.04, 1320);
    }
  },
  goal() {
    this._osc('square', 440, 0.18, 0.32, 0.008, 0.06);
    setTimeout(() => this._osc('square', 660, 0.18, 0.32, 0.008, 0.06), 130);
    setTimeout(() => this._osc('square', 880, 0.26, 0.32, 0.008, 0.1), 260);
    setTimeout(() => this._osc('sawtooth', 220, 0.35, 0.18, 0.01, 0.15), 380);
  },
  countBeep(low = false) {
    this._osc('triangle', low ? 440 : 880, 0.12, 0.22, 0.005, 0.05);
  },
  thud(power = 0.5) {
    this._noise(0.1, 0.18 * power, 400);
  },
  supersonic() {
    this._osc('sawtooth', 180, 0.3, 0.25, 0.02, 0.15, 1200);
    setTimeout(() => this._osc('square', 900, 0.2, 0.18, 0.005, 0.1, 1800), 80);
    this._noise(0.3, 0.15, 3000);
  },
  flip() {
    this._osc('triangle', 320, 0.12, 0.22, 0.005, 0.05, 880);
    this._noise(0.08, 0.1, 1200);
  },
  combo(level = 1) {
    const f = 800 + level * 110;
    this._osc('square', f, 0.1, 0.2, 0.003, 0.05, f * 2);
    if (level >= 4) {
      setTimeout(() => this._osc('triangle', f * 1.5, 0.12, 0.15, 0.003, 0.06, f * 3), 60);
    }
  },
  // パワーアップ取得 (アルペジオ)
  powerup() {
    this._osc('triangle', 660, 0.1, 0.2, 0.003, 0.05);
    setTimeout(() => this._osc('triangle', 880, 0.1, 0.2, 0.003, 0.05), 70);
    setTimeout(() => this._osc('triangle', 1320, 0.14, 0.25, 0.003, 0.08), 140);
  },
  // ハンドブレーキ/スライド
  slide() {
    this._noise(0.18, 0.15, 1800);
  },
};

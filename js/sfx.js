// ============= 効果音 (Web Audio API でランタイム生成) =============
// ライブラリ不要・追加アセット不要で軽量。最初のユーザー操作で context.resume()
const SFX = {
  ctx: null,
  master: null,
  enabled: true,
  _muted: false,

  init() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      console.warn('audio init failed', e);
    }
    // 最初のタッチ/クリックで resume
    const resume = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('touchstart', resume, { once: false, passive: true });
    window.addEventListener('mousedown', resume, { once: false });
    window.addEventListener('keydown', resume, { once: false });
  },

  mute(v) {
    this._muted = !!v;
    if (this.master) this.master.gain.value = this._muted ? 0 : 0.45;
  },

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

  // ボールヒット (パワー 0-1)
  ballHit(power = 0.5) {
    const p = Utils.clamp(power, 0, 1);
    this._osc('square', 200 + p * 220, 0.08, 0.18 + p * 0.2, 0.005, 0.05, 80);
    this._noise(0.12, 0.16 + p * 0.18, 1500 + p * 1500);
  },
  // 強打 (大きく飛ばす時)
  ballSmash(power = 1) {
    this._osc('sawtooth', 320, 0.16, 0.32, 0.008, 0.1, 60);
    this._noise(0.22, 0.32, 2400);
  },
  // ジャンプ
  jump() {
    this._osc('triangle', 480, 0.13, 0.22, 0.005, 0.04, 820);
  },
  // ダブルジャンプ
  doubleJump() {
    this._osc('triangle', 720, 0.16, 0.22, 0.005, 0.05, 1100);
  },
  // ブーストパッド取得
  boostPad(big = false) {
    if (big) {
      this._osc('sawtooth', 220, 0.18, 0.22, 0.008, 0.1, 880);
      this._osc('square', 660, 0.12, 0.12, 0.01, 0.06, 1320);
    } else {
      this._osc('sine', 880, 0.08, 0.16, 0.005, 0.04, 1320);
    }
  },
  // ゴール
  goal() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    this._osc('square', 440, 0.18, 0.32, 0.008, 0.06);
    setTimeout(() => this._osc('square', 660, 0.18, 0.32, 0.008, 0.06), 130);
    setTimeout(() => this._osc('square', 880, 0.26, 0.32, 0.008, 0.1), 260);
    setTimeout(() => this._osc('sawtooth', 220, 0.35, 0.18, 0.01, 0.15), 380);
  },
  // カウントダウンビープ
  countBeep(low = false) {
    this._osc('triangle', low ? 440 : 880, 0.12, 0.22, 0.005, 0.05);
  },
  // 衝突 (壁・車同士)
  thud(power = 0.5) {
    this._noise(0.1, 0.18 * power, 400);
  },
};

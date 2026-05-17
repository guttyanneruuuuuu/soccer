// ============= UI フロー (タイトル → ロビー → ゲーム) =============
const App = {
  screen: 'title',
  myInfo: { name: 'Player', color: '#E53935', team: 'blue' },
  matchDuration: 300, // 秒

  init() {
    SFX.init();
    Input.init();
    Game.init();

    // 名前
    const nameInput = document.getElementById('player-name');
    if (nameInput) {
      const saved = localStorage.getItem('soccer-name');
      if (saved) nameInput.value = saved;
      this.myInfo.name = nameInput.value || 'Player';
      nameInput.addEventListener('change', () => {
        this.myInfo.name = nameInput.value.trim() || 'Player';
        localStorage.setItem('soccer-name', this.myInfo.name);
      });
    }

    // カラー
    document.querySelectorAll('#car-options .car-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#car-options .car-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this.myInfo.color = opt.dataset.color;
      });
    });

    // チーム
    document.querySelectorAll('#team-options .team-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#team-options .team-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this.myInfo.team = opt.dataset.team;
      });
    });

    // マッチサイズ
    document.querySelectorAll('#size-options .size-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#size-options .size-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        Game.matchSize = parseInt(opt.dataset.size, 10);
      });
    });

    // Bot 難易度
    document.querySelectorAll('#bot-difficulty .size-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#bot-difficulty .size-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        Game.botDifficulty = opt.dataset.diff;
        try { localStorage.setItem('soccer-bot-diff', Game.botDifficulty); } catch (_) {}
      });
    });

    // 試合時間
    document.querySelectorAll('#match-duration .size-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#match-duration .size-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this.matchDuration = parseInt(opt.dataset.dur, 10);
        try { localStorage.setItem('soccer-duration', String(this.matchDuration)); } catch (_) {}
      });
    });

    // 保存された設定の復元
    try {
      const sd = localStorage.getItem('soccer-bot-diff');
      if (sd) {
        Game.botDifficulty = sd;
        const btn = document.querySelector(`#bot-difficulty .size-option[data-diff="${sd}"]`);
        if (btn) {
          document.querySelectorAll('#bot-difficulty .size-option').forEach(o => o.classList.remove('active'));
          btn.classList.add('active');
        }
      }
      const md = parseInt(localStorage.getItem('soccer-duration'), 10);
      if (md && [120, 300, 600].includes(md)) {
        this.matchDuration = md;
        document.querySelectorAll('#match-duration .size-option').forEach(o => o.classList.remove('active'));
        const btn = document.querySelector(`#match-duration .size-option[data-dur="${md}"]`);
        if (btn) btn.classList.add('active');
      }
    } catch (_) {}

    // ボタン
    document.getElementById('btn-create-room').addEventListener('click', () => this._onCreateRoom());
    document.getElementById('btn-join-room').addEventListener('click', () => this._showJoin());
    document.getElementById('btn-solo').addEventListener('click', () => this._onSolo());
    document.getElementById('btn-do-join').addEventListener('click', () => this._onJoin());
    document.getElementById('btn-join-back').addEventListener('click', () => this._show('title'));
    document.getElementById('btn-start-match').addEventListener('click', () => this._hostStart());
    document.getElementById('btn-leave-room').addEventListener('click', () => this._leaveRoom());
    document.getElementById('btn-copy-code').addEventListener('click', () => this._copyCode());
    document.getElementById('btn-back-lobby').addEventListener('click', () => this._backFromGame());

    // ロビー: チーム切替
    document.getElementById('btn-team-blue').addEventListener('click', () => this._setMyTeam('blue'));
    document.getElementById('btn-team-orange').addEventListener('click', () => this._setMyTeam('orange'));

    // ジャイロ
    document.getElementById('btn-enable-gyro').addEventListener('click', async () => {
      const ok = await Input.enableGyro();
      document.getElementById('gyro-permission').classList.remove('show');
      if (ok) {
        showToast('🎮 ジャイロ有効！スマホを横向きに！', 1800);
        this._tryLockLandscape();
      } else {
        showToast('ジャイロ許可されませんでした', 1800);
      }
    });
    document.getElementById('btn-skip-gyro').addEventListener('click', () => {
      document.getElementById('gyro-permission').classList.remove('show');
    });

    // ゲーム内設定
    document.getElementById('btn-recalibrate').addEventListener('click', () => {
      Input.recalibrate();
      showToast('🧭 ジャイロ基準リセット', 1000);
    });
    document.getElementById('btn-toggle-sens').addEventListener('click', () => {
      document.getElementById('sensitivity-ctrl').classList.toggle('show');
    });
    const sensSlider = document.getElementById('sens-slider');
    if (sensSlider) {
      sensSlider.value = Input.sensitivity;
      document.getElementById('sens-val').textContent = `${Input.sensitivity}°`;
      sensSlider.addEventListener('input', () => {
        Input.setSensitivity(parseFloat(sensSlider.value));
        document.getElementById('sens-val').textContent = `${sensSlider.value}°`;
      });
    }
    const sensInvert = document.getElementById('sens-invert');
    if (sensInvert) {
      sensInvert.checked = Input.invert;
      sensInvert.addEventListener('change', () => Input.setInvert(sensInvert.checked));
    }
    const sensAutoBoost = document.getElementById('sens-autoboost');
    if (sensAutoBoost) {
      sensAutoBoost.checked = Input.autoBoost;
      sensAutoBoost.addEventListener('change', () => Input.setAutoBoost(sensAutoBoost.checked));
    }
    const sensCurve = document.getElementById('sens-curve');
    const sensCurveVal = document.getElementById('sens-curve-val');
    if (sensCurve && sensCurveVal) {
      sensCurve.value = Math.round(Input.steerCurveExp * 100);
      sensCurveVal.textContent = Input.steerCurveExp.toFixed(2);
      sensCurve.addEventListener('input', () => {
        const v = parseInt(sensCurve.value, 10) / 100;
        Input.setCurve(v);
        sensCurveVal.textContent = v.toFixed(2);
      });
    }
    const sensRecal = document.getElementById('sens-recal');
    if (sensRecal) {
      sensRecal.addEventListener('click', () => {
        Input.recalibrate();
        showToast('🧭 ジャイロ基準リセット', 1000);
      });
    }
    // ポーズ
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (confirm('試合を抜けますか？')) {
          this._backFromGame(true);
        }
      });
    }

    // ネット
    Net.on('roomReady', (code) => {
      document.getElementById('room-code-show').textContent = code;
      this._show('lobby');
      this._renderLobby();
    });
    Net.on('playersChanged', () => this._renderLobby());
    Net.on('joined', () => {
      document.getElementById('room-code-show').textContent = Net.roomCode;
      this._show('lobby');
      this._renderLobby();
    });
    Net.on('rejected', (reason) => {
      const e = document.getElementById('join-error');
      e.textContent = reason === 'full' ? '部屋が満員です' : '入室を拒否されました';
    });
    Net.on('disconnected', () => {
      showToast('🔌 切断されました', 2000);
      this._show('title');
    });
    Net.on('gameStart', (opts) => {
      this._show('game');
      Game.startMatch(opts);
    });

    this._show('title');

    // デバッグ用ショートカット
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autosolo') === '1') {
        setTimeout(() => this._onSolo(), 400);
      }
    } catch (_) {}

    // デバッグキー: G=自分側にゴール強制 / O=相手側にゴール強制 / Tab=スコア倍速
    window.addEventListener('keydown', (e) => {
      if (!Game.running) return;
      if (e.key === 'g' && e.ctrlKey) {
        // Ctrl+G: ボールをBLUE側ゴールに飛ばす
        if (Game.ball) {
          Game.ball.x = 0;
          Game.ball.y = BallPhys.RADIUS + 6;
          Game.ball.z = Arena.L / 2 + 5;
          Game.ball.vx = 0; Game.ball.vy = 0; Game.ball.vz = 60;
        }
      }
      if (e.key === 'o' && e.ctrlKey) {
        if (Game.ball) {
          Game.ball.x = 0;
          Game.ball.y = BallPhys.RADIUS + 6;
          Game.ball.z = -Arena.L / 2 - 5;
          Game.ball.vx = 0; Game.ball.vy = 0; Game.ball.vz = -60;
        }
      }
    });

    // ジャイロ自動有効化 (Android系)
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOSは明示許可必須なので何もしない
    } else {
      Input.enableGyro().then(ok => {
        if (ok) console.log('gyro auto-enabled');
      }).catch(() => {});
    }
  },

  _tryLockLandscape() {
    // 一部Android端末で横画面ロックを試みる
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (_) {}
  },

  _show(name) {
    this.screen = name;
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const id = 'screen-' + name;
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  },

  _showJoin() {
    document.getElementById('join-error').textContent = '';
    document.getElementById('room-code-input').value = '';
    this._show('join');
  },

  _maybeAskGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (!Input.gyroEnabled) {
        document.getElementById('gyro-permission').classList.add('show');
      }
    }
  },

  async _onCreateRoom() {
    this._readMyInfo();
    this._maybeAskGyro();
    this._tryLockLandscape();
    try {
      await Net.createRoom({ name: this.myInfo.name, color: this.myInfo.color, team: this.myInfo.team });
    } catch (e) {
      showToast('部屋作成失敗: ' + (e.message || ''), 2500);
    }
  },

  async _onJoin() {
    this._readMyInfo();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (code.length < 4) {
      document.getElementById('join-error').textContent = '部屋コードが短すぎます';
      return;
    }
    this._maybeAskGyro();
    this._tryLockLandscape();
    try {
      await Net.joinRoom(code, { name: this.myInfo.name, color: this.myInfo.color, team: this.myInfo.team });
    } catch (e) {
      document.getElementById('join-error').textContent = e.message || '入室失敗';
    }
  },

  _onSolo() {
    this._readMyInfo();
    this._maybeAskGyro();
    this._tryLockLandscape();
    const players = [{ id: 'me', name: this.myInfo.name, color: this.myInfo.color, team: this.myInfo.team, isLocal: true }];
    Game.myInfo = { id: 'me', name: this.myInfo.name, color: this.myInfo.color, team: this.myInfo.team };
    const oppositeTeam = this.myInfo.team === 'blue' ? 'orange' : 'blue';
    const size = Game.matchSize;
    const myTeamColor = this.myInfo.color;
    const teamMatePalette = ['#26C6DA', '#66BB6A', '#AB47BC', '#FF7043', '#FFA000', '#5C6BC0'];
    const enemyPalette = ['#EF5350', '#FFA726', '#7E57C2', '#42A5F5', '#26A69A', '#EC407A'];
    for (let i = 1; i < size; i++) {
      players.push({
        id: 'bot-blue-' + i,
        name: 'BOT' + i,
        color: teamMatePalette[i - 1] || '#888',
        team: this.myInfo.team,
      });
    }
    for (let i = 0; i < size; i++) {
      players.push({
        id: 'bot-org-' + i,
        name: 'CPU' + (i + 1),
        color: enemyPalette[i] || '#aaa',
        team: oppositeTeam,
      });
    }
    this._show('game');
    Game.startMatch({ players, duration: this.matchDuration });
  },

  _readMyInfo() {
    const nameInput = document.getElementById('player-name');
    if (nameInput) this.myInfo.name = nameInput.value.trim() || 'Player';
    const activeColor = document.querySelector('#car-options .car-option.active');
    if (activeColor) this.myInfo.color = activeColor.dataset.color;
    const activeTeam = document.querySelector('#team-options .team-option.active');
    if (activeTeam) this.myInfo.team = activeTeam.dataset.team;
    Game.myInfo = { id: Net.myId || 'me', name: this.myInfo.name, color: this.myInfo.color, team: this.myInfo.team };
  },

  _renderLobby() {
    const list = document.getElementById('player-list');
    if (!list) return;
    list.innerHTML = '';
    const players = Array.from(Net.players.values());
    for (const p of players) {
      const div = document.createElement('div');
      div.className = 'player-row';
      div.innerHTML = `
        <span class="dot" style="background:${p.color}"></span>
        <span class="name">${escapeHtml(p.name || '?')}${p.isHost ? ' 👑' : ''}</span>
        <span class="team team-${p.team || 'blue'}">${p.team === 'orange' ? 'ORANGE' : 'BLUE'}</span>
      `;
      list.appendChild(div);
    }
    document.getElementById('player-count').textContent = `${players.length} / ${Net.MAX_PLAYERS}`;

    const startBtn = document.getElementById('btn-start-match');
    if (Net.isHost) startBtn.style.display = '';
    else startBtn.style.display = 'none';

    const me = Net.players.get(Net.myId);
    if (me) {
      this.myInfo.team = me.team;
      document.getElementById('btn-team-blue').classList.toggle('active', me.team === 'blue');
      document.getElementById('btn-team-orange').classList.toggle('active', me.team === 'orange');
    }
  },

  _setMyTeam(team) {
    this.myInfo.team = team;
    Game.myInfo.team = team;
    if (Net.isHost) {
      const p = Net.players.get(Net.myId);
      if (p) p.team = team;
      Net._broadcast({ type: 'playersChanged', players: Net._playerList() });
      this._renderLobby();
    } else {
      Net.sendToHost({ type: 'team', team });
    }
  },

  _hostStart() {
    if (!Net.isHost) return;
    const playerList = Net._playerList();
    // バランスチェック: チーム差>1 ならエラー
    let blue = 0, orange = 0;
    for (const p of playerList) {
      if (p.team === 'blue') blue++;
      else if (p.team === 'orange') orange++;
    }
    if (Math.abs(blue - orange) > 1) {
      showToast(`⚖️ チームバランスが悪いです (${blue} vs ${orange})`, 2200);
    }
    // 上限チェック
    const sizeLimit = Math.max(blue, orange);
    if (sizeLimit > 4) {
      showToast('1チーム最大4人までです', 2200);
      return;
    }
    const players = playerList.map(p => ({
      id: p.id, name: p.name, color: p.color, team: p.team || 'blue',
    }));
    Game.myInfo.id = Net.myId;
    Net.startGame({ players, duration: this.matchDuration });
  },

  _leaveRoom() {
    Net.leave();
    this._show('title');
  },

  _copyCode() {
    const code = document.getElementById('room-code-show').textContent;
    if (!code) return;
    try {
      navigator.clipboard.writeText(code);
      showToast('📋 コピーしました', 1200);
    } catch (_) {}
  },

  _backFromGame(forceLeave = false) {
    document.getElementById('finish-overlay').classList.remove('show');
    Game.running = false;
    if (forceLeave && Net.peer) {
      Net.leave();
      this._show('title');
    } else if (Net.peer) {
      this._show('lobby');
    } else {
      this._show('title');
    }
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

window.addEventListener('DOMContentLoaded', () => App.init());

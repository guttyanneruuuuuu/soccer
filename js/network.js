// ============= ネットワーク（PeerJS による P2P マルチプレイヤー） =============
// ホストオーソリ方式:
// - クライアントは自分の入力(steer/accel/brake/jump/boost)とローカル状態をホストへ送信
// - ホストは全車の物理シミュレーション + ボール物理 + ゴール判定をして、定期的に全員へ配信
// - クライアントは受信状態を補間しながら描画
const Net = {
  peer: null,
  isHost: false,
  myId: null,
  roomCode: null,
  conns: new Map(),       // ホスト側: clientId -> DataConnection
  hostConn: null,         // クライアント側: ホストへの接続
  players: new Map(),     // id -> {id, name, color, team, isHost}
  callbacks: {},
  ROOM_PREFIX: 'soccer-rl-v1-',
  MAX_PLAYERS: 8,

  on(event, fn) { (this.callbacks[event] ||= []).push(fn); },
  _emit(event, ...args) { (this.callbacks[event] || []).forEach(fn => fn(...args)); },

  _newPeer(id) {
    return new Peer(id, { debug: 1 });
  },

  createRoom(myInfo) {
    return new Promise((resolve, reject) => {
      this._resetSession();
      this.isHost = true;
      this.roomCode = Utils.genRoomCode();
      const peerId = this.ROOM_PREFIX + this.roomCode;
      this.peer = this._newPeer(peerId);
      this.myId = peerId;

      const timeout = setTimeout(() => {
        try { if (this.peer) this.peer.destroy(); } catch (_) {}
        reject(new Error('接続タイムアウト'));
      }, 15000);

      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        // ホストはチーム自動: blue を初期にしておく
        this.players.set(id, { ...myInfo, id, isHost: true });
        this._emit('roomReady', this.roomCode);
        this._emit('playersChanged', this._playerList());
        resolve(this.roomCode);
      });

      this.peer.on('connection', (conn) => {
        if (this.players.size >= this.MAX_PLAYERS) {
          conn.on('open', () => {
            conn.send({ type: 'reject', reason: 'full' });
            setTimeout(() => conn.close(), 300);
          });
          return;
        }
        this.conns.set(conn.peer, conn);
        conn.on('data', (data) => this._onHostReceive(conn, data));
        conn.on('close', () => this._onClientLeave(conn.peer));
        conn.on('error', () => this._onClientLeave(conn.peer));
      });

      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        console.error('peer error', err);
        if (err.type === 'unavailable-id') {
          this.peer.destroy();
          this.createRoom(myInfo).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  },

  joinRoom(code, myInfo) {
    return new Promise((resolve, reject) => {
      this._resetSession();
      this.isHost = false;
      this.roomCode = code.toUpperCase();
      const myPeerId = this.ROOM_PREFIX + this.roomCode + '-' + Math.random().toString(36).slice(2, 8);
      this.peer = this._newPeer(myPeerId);
      this.myId = myPeerId;

      const timeout = setTimeout(() => {
        try { if (this.peer) this.peer.destroy(); } catch (_) {}
        reject(new Error('接続タイムアウト'));
      }, 15000);

      this.peer.on('open', () => {
        const hostPeerId = this.ROOM_PREFIX + this.roomCode;
        const conn = this.peer.connect(hostPeerId, { reliable: true });
        this.hostConn = conn;
        conn.on('open', () => {
          clearTimeout(timeout);
          conn.send({ type: 'join', info: myInfo });
          resolve();
        });
        conn.on('data', (data) => this._onClientReceive(data));
        conn.on('close', () => {
          this._emit('disconnected');
        });
        conn.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        if (err.type === 'peer-unavailable') {
          reject(new Error('部屋が見つかりません'));
        } else {
          reject(err);
        }
      });
    });
  },

  _resetSession() {
    if (this.peer) { try { this.peer.destroy(); } catch (_) {} }
    this.peer = null;
    this.conns = new Map();
    this.hostConn = null;
    this.players = new Map();
    this.myId = null;
    this.roomCode = null;
  },

  leave() {
    if (this.isHost) {
      this._broadcast({ type: 'roomClosed' });
    } else if (this.hostConn) {
      try { this.hostConn.send({ type: 'leave' }); } catch (_) {}
    }
    this._resetSession();
    this._emit('disconnected');
  },

  _playerList() {
    return Array.from(this.players.values());
  },

  // ===== ホスト側受信 =====
  _onHostReceive(conn, data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'join': {
        if (this.players.size >= this.MAX_PLAYERS) {
          conn.send({ type: 'reject', reason: 'full' });
          return;
        }
        const info = data.info || {};
        // チームを自動割当（少ない方）
        const team = this._autoTeam();
        const p = { ...info, id: conn.peer, isHost: false, team };
        this.players.set(conn.peer, p);
        // クライアントへ完全状態送信
        conn.send({
          type: 'welcome',
          you: p,
          players: this._playerList(),
          roomCode: this.roomCode,
        });
        // 全員に通知
        this._broadcast({ type: 'playersChanged', players: this._playerList() });
        this._emit('playersChanged', this._playerList());
        break;
      }
      case 'leave': {
        this._onClientLeave(conn.peer);
        break;
      }
      case 'team': {
        const p = this.players.get(conn.peer);
        if (p && (data.team === 'blue' || data.team === 'orange')) {
          p.team = data.team;
          this._broadcast({ type: 'playersChanged', players: this._playerList() });
          this._emit('playersChanged', this._playerList());
        }
        break;
      }
      case 'input': {
        // クライアント入力を受信
        this._emit('clientInput', conn.peer, data.input);
        break;
      }
      case 'chat': {
        this._broadcast({ type: 'chat', from: conn.peer, msg: data.msg });
        this._emit('chat', conn.peer, data.msg);
        break;
      }
    }
  },

  _onClientLeave(id) {
    if (this.players.has(id)) {
      this.players.delete(id);
      const c = this.conns.get(id);
      if (c) { try { c.close(); } catch (_) {} }
      this.conns.delete(id);
      this._broadcast({ type: 'playersChanged', players: this._playerList() });
      this._emit('playersChanged', this._playerList());
      this._emit('playerLeft', id);
    }
  },

  _autoTeam() {
    let blue = 0, orange = 0;
    for (const p of this.players.values()) {
      if (p.team === 'blue') blue++;
      else if (p.team === 'orange') orange++;
    }
    return blue <= orange ? 'blue' : 'orange';
  },

  // ===== クライアント側受信 =====
  _onClientReceive(data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'welcome': {
        this.players = new Map(data.players.map(p => [p.id, p]));
        this._emit('joined', data.you, data.players);
        this._emit('playersChanged', data.players);
        break;
      }
      case 'reject': {
        this._emit('rejected', data.reason);
        break;
      }
      case 'playersChanged': {
        this.players = new Map(data.players.map(p => [p.id, p]));
        this._emit('playersChanged', data.players);
        break;
      }
      case 'gameStart': {
        this._emit('gameStart', data);
        break;
      }
      case 'state': {
        this._emit('state', data);
        break;
      }
      case 'goal': {
        this._emit('goal', data);
        break;
      }
      case 'gameEnd': {
        this._emit('gameEnd', data);
        break;
      }
      case 'roomClosed': {
        this._emit('disconnected');
        this._resetSession();
        break;
      }
      case 'chat': {
        this._emit('chat', data.from, data.msg);
        break;
      }
      case 'powerupTaken': {
        this._emit('powerupTaken', data);
        break;
      }
      case 'powerupSpawn': {
        this._emit('powerupSpawn', data);
        break;
      }
      case 'kickoffReset': {
        this._emit('kickoffReset');
        break;
      }
    }
  },

  // ===== ホスト用ブロードキャスト =====
  _broadcast(data, exceptId = null) {
    for (const [id, conn] of this.conns) {
      if (id === exceptId) continue;
      try { conn.send(data); } catch (_) {}
    }
  },
  sendToHost(data) {
    if (!this.hostConn) return;
    try { this.hostConn.send(data); } catch (_) {}
  },
  sendToAll(data) {
    if (this.isHost) this._broadcast(data);
    else this.sendToHost(data);
  },

  // ホスト: ゲーム開始
  startGame(opts) {
    if (!this.isHost) return;
    this._broadcast({ type: 'gameStart', ...opts });
    this._emit('gameStart', opts);
  },

  // ホスト: 状態配信
  broadcastState(state) {
    if (!this.isHost) return;
    this._broadcast({ type: 'state', ...state });
  },
  broadcastGoal(info) {
    if (!this.isHost) return;
    this._broadcast({ type: 'goal', ...info });
  },
  broadcastEnd(info) {
    if (!this.isHost) return;
    this._broadcast({ type: 'gameEnd', ...info });
  },
};

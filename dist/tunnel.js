"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tunnel = void 0;
exports.openTunnel = openTunnel;
// A PTCP tunnel to a Dahua device: TCP connections to the device's own ports
// (RTSP 554, HTTP 80, 37777…) carried as "realms" over one PTCP session.
const node_stream_1 = require("node:stream");
const node_net_1 = __importDefault(require("node:net"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_events_1 = require("node:events");
const dhhttp_js_1 = require("./dhhttp.js");
const handshake_js_1 = require("./handshake.js");
const ptcp_js_1 = require("./ptcp.js");
const BIND_TIMEOUT_MS = 8000;
const BUSY_RETRY_MS = 35_000;
const BUSY_RETRY_WAIT_MS = 4000;
const DISC_TIMEOUT_MS = 2000;
class Realm extends node_stream_1.Duplex {
    id;
    tunnel;
    finished = false;
    constructor(id, tunnel) {
        super({ allowHalfOpen: false });
        this.id = id;
        this.tunnel = tunnel;
    }
    _read() {
        /* data is pushed as the device sends it (UDP has no back-pressure) */
    }
    _write(chunk, _enc, cb) {
        if (this.tunnel.closed)
            return cb(new Error('tunnel closed'));
        this.tunnel.session.sendData(this.id, chunk);
        cb();
    }
    _final(cb) {
        this.tunnel.disconnect(this);
        cb();
    }
    _destroy(err, cb) {
        this.tunnel.disconnect(this);
        cb(err);
    }
    /** Called by the tunnel when the device closes this realm. */
    remoteClosed() {
        if (this.finished)
            return;
        this.finished = true;
        this.push(null);
    }
}
/** Events: 'closed' (reason) */
class Tunnel extends node_events_1.EventEmitter {
    sock;
    session;
    handshake;
    log;
    realms = new Map();
    pendingBinds = new Map();
    pendingDiscs = new Map();
    /** Dahua handles one realm at a time: the next bind waits for the previous DISC. */
    gate = Promise.resolve();
    closeReason = null;
    constructor(sock, session, handshake, log) {
        super();
        this.sock = sock;
        this.session = session;
        this.handshake = handshake;
        this.log = log;
        session.on('body', (b) => this.onBody(b));
        session.on('closed', (reason) => this.close(reason));
    }
    static async open(opts) {
        const deadline = Date.now() + (opts.busyRetryMs ?? BUSY_RETRY_MS);
        for (let attempt = 1;; attempt++) {
            const sock = new dhhttp_js_1.DhSocket(opts.log);
            await sock.bind();
            try {
                const hs = await (0, handshake_js_1.relayHandshake)(sock, opts.serial, { log: opts.log, timeoutMs: opts.timeoutMs, cloud: opts.cloud });
                return new Tunnel(sock, hs.session, hs, opts.log);
            }
            catch (err) {
                sock.close();
                if (!(err instanceof handshake_js_1.DeviceBusy) || Date.now() + BUSY_RETRY_WAIT_MS > deadline)
                    throw err;
                opts.log?.(`device busy (attempt ${attempt}), retrying in ${BUSY_RETRY_WAIT_MS / 1000} s`);
                await new Promise(r => setTimeout(r, BUSY_RETRY_WAIT_MS));
            }
        }
    }
    get closed() {
        return this.closeReason !== null;
    }
    get stats() {
        return {
            udpBytesIn: this.sock.bytesIn,
            udpBytesOut: this.sock.bytesOut,
            ptcp: { ...this.session.stats },
            handshakeMs: this.handshake.timings.sync ?? 0,
        };
    }
    /** Opens a TCP connection to `port` on the device (default RTSP). */
    connect(port = 554) {
        const run = async () => {
            if (this.closed)
                throw new Error(`tunnel closed (${this.closeReason})`);
            const id = node_crypto_1.default.randomInt(1, 0x7fffffff);
            const realm = new Realm(id, this);
            this.realms.set(id, realm);
            const ok = await new Promise(resolve => {
                const timer = setTimeout(() => {
                    this.pendingBinds.delete(id);
                    resolve(false);
                }, BIND_TIMEOUT_MS);
                this.pendingBinds.set(id, v => {
                    clearTimeout(timer);
                    resolve(v);
                });
                this.session.send(ptcp_js_1.bodies.bind(id, port));
            });
            if (!ok) {
                this.realms.delete(id);
                throw new Error(`device refused or ignored the connection to port ${port}`);
            }
            this.log?.(`realm ${id.toString(16)} connected to device port ${port}`);
            return realm;
        };
        // Serialize: wait until the previous realm is gone before binding the next
        const result = this.gate.then(run);
        this.gate = result.then(realm => new Promise(resolve => realm.once('close', () => resolve())), () => undefined);
        return result;
    }
    /** Exposes `remotePort` on the device as a local TCP port (for ffmpeg, VLC…). */
    listen(localPort, remotePort = 554, host = '127.0.0.1') {
        const server = node_net_1.default.createServer(client => {
            this.connect(remotePort).then(realm => {
                client.pipe(realm).pipe(client);
                client.on('error', () => realm.destroy());
                realm.on('error', () => client.destroy());
                client.on('close', () => realm.destroy());
                realm.on('close', () => client.destroy());
            }, err => {
                this.log?.(`listen: ${err.message}`);
                client.destroy();
            });
        });
        this.once('closed', () => server.close());
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(localPort, host, () => resolve(server));
        });
    }
    /** Ends a realm on our side (called by the Realm stream). */
    disconnect(realm) {
        if (!this.realms.has(realm.id))
            return;
        this.realms.delete(realm.id);
        if (this.closed)
            return;
        this.session.send(ptcp_js_1.bodies.status(realm.id, 'DISC'));
        // Keep the gate closed briefly so the device can release the realm
        const done = new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingDiscs.delete(realm.id);
                resolve();
            }, DISC_TIMEOUT_MS);
            this.pendingDiscs.set(realm.id, () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.gate = this.gate.then(() => done);
    }
    onBody(b) {
        switch (b.type) {
            case 'data': {
                const realm = this.realms.get(b.realm);
                if (realm)
                    realm.push(Buffer.from(b.data));
                break;
            }
            case 'status': {
                const status = b.status.replace(/\0+$/, '');
                if (status === 'CONN') {
                    const pending = this.pendingBinds.get(b.realm);
                    this.pendingBinds.delete(b.realm);
                    pending?.(true);
                }
                else if (status === 'DISC') {
                    this.pendingBinds.get(b.realm)?.(false);
                    this.pendingBinds.delete(b.realm);
                    this.pendingDiscs.get(b.realm)?.();
                    this.pendingDiscs.delete(b.realm);
                    const realm = this.realms.get(b.realm);
                    if (realm) {
                        this.realms.delete(b.realm);
                        realm.remoteClosed();
                        realm.destroy();
                    }
                }
                break;
            }
            case 'command':
                this.log?.(`ptcp command 0x${b.code.toString(16)} (${b.payload.length} B)`);
                break;
            default:
                break;
        }
    }
    close(reason = 'closed') {
        if (this.closed)
            return;
        this.closeReason = reason;
        for (const r of this.realms.values())
            r.destroy(new Error(`tunnel closed (${reason})`));
        this.realms.clear();
        for (const p of this.pendingBinds.values())
            p(false);
        this.pendingBinds.clear();
        // Let the device know, best effort, then drop the socket
        if (!this.session.closed)
            this.session.close(reason);
        setTimeout(() => this.sock.close(), 50).unref?.();
        this.emit('closed', reason);
    }
}
exports.Tunnel = Tunnel;
function openTunnel(opts) {
    return Tunnel.open(opts);
}
//# sourceMappingURL=tunnel.js.map
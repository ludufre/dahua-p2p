// A PTCP tunnel to a Dahua device: TCP connections to the device's own ports
// (RTSP 554, HTTP 80, 37777…) carried as "realms" over one PTCP session.
import { Duplex } from 'node:stream';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DhSocket, Logger } from './dhhttp.js';
import { relayHandshake, HandshakeResult, DeviceBusy } from './handshake.js';
import { Body, bodies, PtcpSession, PtcpStats } from './ptcp.js';

export interface TunnelOptions {
  serial: string;
  /** Only 'relay' is implemented; it is what works behind 4G / CGNAT. */
  mode?: 'relay';
  /** Cloud entry point (default Easy4ip, used by Dahua, Intelbras Mibo, Imou). */
  cloud?: string;
  log?: Logger;
  timeoutMs?: number;
  /**
   * Keep retrying while the device is busy (it holds a closed relay session for
   * ~15–20 s) for up to this long (ms). 0 = single attempt. Default 35 s.
   */
  busyRetryMs?: number;
}

export interface TunnelStats {
  /** Bytes on the wire, IPv4/UDP headers included (what a metered link bills). */
  udpBytesIn: number;
  udpBytesOut: number;
  ptcp: PtcpStats;
  handshakeMs: number;
}

const BIND_TIMEOUT_MS = 8000;
const BUSY_RETRY_MS = 35_000;
const BUSY_RETRY_WAIT_MS = 4000;
const DISC_TIMEOUT_MS = 2000;

class Realm extends Duplex {
  private finished = false;

  constructor(
    readonly id: number,
    private tunnel: Tunnel,
  ) {
    super({ allowHalfOpen: false });
  }

  _read(): void {
    /* data is pushed as the device sends it (UDP has no back-pressure) */
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.tunnel.closed) return cb(new Error('tunnel closed'));
    this.tunnel.session.sendData(this.id, chunk);
    cb();
  }

  _final(cb: (err?: Error | null) => void): void {
    this.tunnel.disconnect(this);
    cb();
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.tunnel.disconnect(this);
    cb(err);
  }

  /** Called by the tunnel when the device closes this realm. */
  remoteClosed(): void {
    if (this.finished) return;
    this.finished = true;
    this.push(null);
  }
}

/** Events: 'closed' (reason) */
export class Tunnel extends EventEmitter {
  private realms = new Map<number, Realm>();
  private pendingBinds = new Map<number, (ok: boolean) => void>();
  private pendingDiscs = new Map<number, () => void>();
  /** Dahua handles one realm at a time: the next bind waits for the previous DISC. */
  private gate: Promise<void> = Promise.resolve();
  private closeReason: string | null = null;

  private constructor(
    private sock: DhSocket,
    readonly session: PtcpSession,
    readonly handshake: HandshakeResult,
    private log?: Logger,
  ) {
    super();
    session.on('body', (b: Body) => this.onBody(b));
    session.on('closed', (reason: string) => this.close(reason));
  }

  static async open(opts: TunnelOptions): Promise<Tunnel> {
    const deadline = Date.now() + (opts.busyRetryMs ?? BUSY_RETRY_MS);
    for (let attempt = 1; ; attempt++) {
      const sock = new DhSocket(opts.log);
      await sock.bind();
      try {
        const hs = await relayHandshake(sock, opts.serial, { log: opts.log, timeoutMs: opts.timeoutMs, cloud: opts.cloud });
        return new Tunnel(sock, hs.session, hs, opts.log);
      } catch (err) {
        sock.close();
        if (!(err instanceof DeviceBusy) || Date.now() + BUSY_RETRY_WAIT_MS > deadline) throw err;
        opts.log?.(`device busy (attempt ${attempt}), retrying in ${BUSY_RETRY_WAIT_MS / 1000} s`);
        await new Promise(r => setTimeout(r, BUSY_RETRY_WAIT_MS));
      }
    }
  }

  get closed(): boolean {
    return this.closeReason !== null;
  }

  get stats(): TunnelStats {
    return {
      udpBytesIn: this.sock.bytesIn,
      udpBytesOut: this.sock.bytesOut,
      ptcp: { ...this.session.stats },
      handshakeMs: this.handshake.timings.sync ?? 0,
    };
  }

  /** Opens a TCP connection to `port` on the device (default RTSP). */
  connect(port = 554): Promise<Duplex> {
    const run = async (): Promise<Duplex> => {
      if (this.closed) throw new Error(`tunnel closed (${this.closeReason})`);
      const id = crypto.randomInt(1, 0x7fffffff);
      const realm = new Realm(id, this);
      this.realms.set(id, realm);
      const ok = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          this.pendingBinds.delete(id);
          resolve(false);
        }, BIND_TIMEOUT_MS);
        this.pendingBinds.set(id, v => {
          clearTimeout(timer);
          resolve(v);
        });
        this.session.send(bodies.bind(id, port));
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
    this.gate = result.then(
      realm => new Promise<void>(resolve => realm.once('close', () => resolve())),
      () => undefined,
    );
    return result;
  }

  /** Exposes `remotePort` on the device as a local TCP port (for ffmpeg, VLC…). */
  listen(localPort: number, remotePort = 554, host = '127.0.0.1'): Promise<net.Server> {
    const server = net.createServer(client => {
      this.connect(remotePort).then(
        realm => {
          client.pipe(realm).pipe(client);
          client.on('error', () => realm.destroy());
          realm.on('error', () => client.destroy());
          client.on('close', () => realm.destroy());
          realm.on('close', () => client.destroy());
        },
        err => {
          this.log?.(`listen: ${err.message}`);
          client.destroy();
        },
      );
    });
    this.once('closed', () => server.close());
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, host, () => resolve(server));
    });
  }

  /** Ends a realm on our side (called by the Realm stream). */
  disconnect(realm: Realm): void {
    if (!this.realms.has(realm.id)) return;
    this.realms.delete(realm.id);
    if (this.closed) return;
    this.session.send(bodies.status(realm.id, 'DISC'));
    // Keep the gate closed briefly so the device can release the realm
    const done = new Promise<void>(resolve => {
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

  private onBody(b: Body): void {
    switch (b.type) {
      case 'data': {
        const realm = this.realms.get(b.realm);
        if (realm) realm.push(Buffer.from(b.data));
        break;
      }
      case 'status': {
        const status = b.status.replace(/\0+$/, '');
        if (status === 'CONN') {
          const pending = this.pendingBinds.get(b.realm);
          this.pendingBinds.delete(b.realm);
          pending?.(true);
        } else if (status === 'DISC') {
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

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closeReason = reason;
    for (const r of this.realms.values()) r.destroy(new Error(`tunnel closed (${reason})`));
    this.realms.clear();
    for (const p of this.pendingBinds.values()) p(false);
    this.pendingBinds.clear();
    // Let the device know, best effort, then drop the socket
    if (!this.session.closed) this.session.close(reason);
    setTimeout(() => this.sock.close(), 50).unref?.();
    this.emit('closed', reason);
  }
}

export function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  return Tunnel.open(opts);
}

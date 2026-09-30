// PTCP ("PhonyTCP"): Dahua's reliable byte stream over UDP.
//
// Every datagram carries a 24-byte header:
//   "PTCP" | sent | recv | pid | lmid | rmid      (all u32 big-endian)
// `sent` is the byte offset of this datagram's body in the sender's stream and
// `recv` is the cumulative acknowledgement of the other direction — the same
// roles as TCP's seq/ack. Every non-empty body (sync, data, status, heartbeat…)
// consumes offset space; an empty body is a pure ACK.
//
// Through the Easy4ip relay datagrams get lost and reordered, so the receiver
// only advances `recv` over contiguous bytes, parks early datagrams until the gap
// is filled and never delivers a byte twice. Our own bodies are retransmitted
// until the peer acknowledges them.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const BodyType = {
  Sync: 0x00,
  Data: 0x10,
  Bind: 0x11,
  Status: 0x12,
  Heartbeat: 0x13,
  SignRequest: 0x17,
  Sign: 0x18,
  Auth: 0x19,
  AuthAck: 0x1a,
  AuthFin: 0x1b,
} as const;

export const HEADER_SIZE = 24;
/** Largest data chunk per datagram (what the devices themselves use). */
export const MAX_DATA = 1280;
const UDP_OVERHEAD = 28;

export interface PtcpPacket {
  sent: number;
  recv: number;
  pid: number;
  lmid: number;
  rmid: number;
  body: Buffer;
}

export function encodePacket(p: PtcpPacket): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  h.write('PTCP', 0, 'latin1');
  h.writeUInt32BE(p.sent >>> 0, 4);
  h.writeUInt32BE(p.recv >>> 0, 8);
  h.writeUInt32BE(p.pid >>> 0, 12);
  h.writeUInt32BE(p.lmid >>> 0, 16);
  h.writeUInt32BE(p.rmid >>> 0, 20);
  return Buffer.concat([h, p.body]);
}

/** null when the datagram is not PTCP (relay agents also send raw HTTP-like text). */
export function decodePacket(buf: Buffer): PtcpPacket | null {
  if (buf.length < HEADER_SIZE || buf.toString('latin1', 0, 4) !== 'PTCP') return null;
  return {
    sent: buf.readUInt32BE(4),
    recv: buf.readUInt32BE(8),
    pid: buf.readUInt32BE(12),
    lmid: buf.readUInt32BE(16),
    rmid: buf.readUInt32BE(20),
    body: buf.subarray(HEADER_SIZE),
  };
}

// ------------------------------------------------------------------ bodies

const typeHeader = (type: number, len: number, realm: number) => {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(((type << 24) | (len & 0xffffff)) >>> 0, 0);
  b.writeUInt32BE(realm >>> 0, 4);
  return b;
};

export const bodies = {
  sync: () => Buffer.from([0x00, 0x03, 0x01, 0x00]),
  heartbeat: () => typeHeader(BodyType.Heartbeat, 0, 0),
  data: (realm: number, data: Buffer) => Buffer.concat([typeHeader(BodyType.Data, data.length, realm), data]),
  bind: (realm: number, port: number) => {
    const tail = Buffer.alloc(8);
    tail.writeUInt32BE(port >>> 0, 0);
    tail.writeUInt32BE(0x7f000001, 4); // 127.0.0.1 on the device side
    return Buffer.concat([typeHeader(BodyType.Bind, 0, realm), tail]);
  },
  status: (realm: number, status: 'CONN' | 'DISC') => Buffer.concat([typeHeader(BodyType.Status, 4, realm), Buffer.from(status)]),
  command: (type: number, payload: Buffer = Buffer.alloc(0)) => Buffer.concat([typeHeader(type, 0, 0), payload]),
};

export type Body =
  | { type: 'sync' }
  | { type: 'data'; realm: number; data: Buffer }
  | { type: 'bind'; realm: number; port: number }
  | { type: 'status'; realm: number; status: string }
  | { type: 'heartbeat' }
  | { type: 'command'; code: number; payload: Buffer; raw: Buffer };

export function parseBody(b: Buffer): Body {
  const code = b[0];
  if (code === BodyType.Sync) return { type: 'sync' };
  if (b.length < 12) return { type: 'command', code, payload: b.subarray(4), raw: b };
  const realm = b.readUInt32BE(4);
  switch (code) {
    case BodyType.Data: {
      const len = b.readUInt32BE(0) & 0xffffff;
      return { type: 'data', realm, data: b.subarray(12, 12 + len) };
    }
    case BodyType.Bind:
      return { type: 'bind', realm, port: b.length >= 16 ? b.readUInt32BE(12) : 0 };
    case BodyType.Status:
      return { type: 'status', realm, status: b.toString('latin1', 12) };
    case BodyType.Heartbeat:
      return { type: 'heartbeat' };
    default:
      return { type: 'command', code, payload: b.subarray(12), raw: b };
  }
}

// ------------------------------------------------------------------ sequence math

const u32 = (n: number) => n >>> 0;
/** a comes after b in 32-bit wrap-around space. */
export const seqAfter = (a: number, b: number) => {
  const d = u32(a - b);
  return d !== 0 && d < 0x80000000;
};

// ------------------------------------------------------------------ session

export interface PtcpSessionOptions {
  /** Writes one datagram to the peer. */
  transmit: (datagram: Buffer) => void;
  log?: (msg: string) => void;
  /** Coalesces ACKs for this long (ms). */
  ackDelayMs?: number;
  heartbeatMs?: number;
  /** First retransmission timeout (ms); doubles per retry. */
  rtoMs?: number;
  maxRetries?: number;
  /** Closes after this long without hearing from the peer (ms). */
  idleTimeoutMs?: number;
  /** Closes when the peer stops acknowledging our bytes for this long (ms). */
  stallTimeoutMs?: number;
}

interface Outstanding {
  offset: number;
  body: Buffer;
  pid: number;
  firstSentAt: number;
  lastSentAt: number;
  tries: number;
}

export interface PtcpStats {
  datagramsIn: number;
  datagramsOut: number;
  retransmitsOut: number;
  duplicatesIn: number;
  outOfOrderIn: number;
  /** Gaps that were later filled by the peer (i.e. it retransmits). */
  gapsFilled: number;
}

/**
 * Reliable, ordered PTCP stream with one peer.
 * Events: 'body' (Body), 'closed' (reason: string).
 */
export class PtcpSession extends EventEmitter {
  private sndNext = 0;
  private sndUna = 0;
  private count = 0;
  private lmid = crypto.randomInt(1, 0x7fffffff);
  private outstanding: Outstanding[] = [];

  private rcvNext = 0;
  private early = new Map<number, Buffer>();
  private lastPeerLmid = 0;

  private ackTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout;
  private lastHeardAt = Date.now();
  private lastHeartbeatAt = Date.now();
  private lastAckProgressAt = Date.now();
  private closedReason: string | null = null;

  readonly stats: PtcpStats = { datagramsIn: 0, datagramsOut: 0, retransmitsOut: 0, duplicatesIn: 0, outOfOrderIn: 0, gapsFilled: 0 };
  heartbeats = true;

  private readonly o: Required<Omit<PtcpSessionOptions, 'log'>> & Pick<PtcpSessionOptions, 'log'>;

  constructor(opts: PtcpSessionOptions) {
    super();
    this.o = {
      ackDelayMs: 20,
      heartbeatMs: 5000,
      rtoMs: 500,
      maxRetries: 8,
      idleTimeoutMs: 60_000,
      stallTimeoutMs: 20_000,
      ...opts,
    };
    this.ticker = setInterval(() => this.tick(), 100);
    this.ticker.unref?.();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Bytes of the peer's stream received in order (our ACK). */
  get received(): number {
    return this.rcvNext;
  }

  /** Our bytes still waiting for an ACK. */
  get unacked(): number {
    return u32(this.sndNext - this.sndUna);
  }

  // ---------------------------------------------------------------- output

  /** Queues a body for reliable delivery. */
  send(body: Buffer): void {
    if (this.closed) return;
    const isSync = body[0] === BodyType.Sync && body.length === 4;
    const pid = isSync ? 0x0002ffff : u32(0xffff - (this.count & 0xffff));
    if (!isSync) this.count++;
    const o: Outstanding = { offset: this.sndNext, body, pid, firstSentAt: Date.now(), lastSentAt: Date.now(), tries: 0 };
    if (this.outstanding.length === 0) this.lastAckProgressAt = Date.now();
    this.outstanding.push(o);
    this.sndNext = u32(this.sndNext + body.length);
    this.transmitBody(o.offset, pid, body);
  }

  sendData(realm: number, data: Buffer): void {
    for (let i = 0; i < data.length; i += MAX_DATA) this.send(bodies.data(realm, data.subarray(i, i + MAX_DATA)));
  }

  private transmitBody(offset: number, pid: number, body: Buffer): void {
    this.cancelAck(); // every datagram carries our current ACK
    this.stats.datagramsOut++;
    this.o.transmit(
      encodePacket({ sent: offset, recv: this.rcvNext, pid, lmid: this.lmid++, rmid: this.lastPeerLmid, body }),
    );
  }

  private sendAck(): void {
    this.ackTimer = null;
    if (this.closed) return;
    this.stats.datagramsOut++;
    this.o.transmit(
      encodePacket({
        sent: this.sndNext,
        recv: this.rcvNext,
        pid: u32(0xffff - (this.count & 0xffff)),
        lmid: this.lmid++,
        rmid: this.lastPeerLmid,
        body: Buffer.alloc(0),
      }),
    );
  }

  private scheduleAck(immediate = false): void {
    if (immediate) {
      this.cancelAck();
      this.sendAck();
    } else if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => this.sendAck(), this.o.ackDelayMs);
    }
  }

  private cancelAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  // ---------------------------------------------------------------- input

  /** Feeds one datagram received from the peer. Returns false if it was not PTCP. */
  input(datagram: Buffer): boolean {
    const p = decodePacket(datagram);
    if (!p || this.closed) return !!p;
    this.stats.datagramsIn++;
    this.lastHeardAt = Date.now();
    this.lastPeerLmid = p.lmid;
    this.onPeerAck(p.recv);
    if (p.body.length === 0) return true;

    const len = p.body.length;
    if (p.sent === this.rcvNext) {
      this.accept(p.body);
      while (this.early.size) {
        const next = this.early.get(this.rcvNext);
        if (!next) break;
        this.early.delete(this.rcvNext);
        this.stats.gapsFilled++;
        this.accept(next);
      }
      this.scheduleAck(this.early.size > 0);
    } else if (seqAfter(p.sent, this.rcvNext)) {
      // A gap: keep it for later and tell the peer right away where we are
      if (!this.early.has(p.sent)) {
        this.stats.outOfOrderIn++;
        if (this.early.size < 4096) this.early.set(p.sent, Buffer.from(p.body));
      } else this.stats.duplicatesIn++;
      this.scheduleAck(true);
    } else {
      const end = u32(p.sent + len);
      if (seqAfter(end, this.rcvNext)) {
        // Overlaps what we have: take only the new tail (not seen from Dahua so far)
        this.accept(p.body.subarray(u32(this.rcvNext - p.sent)), true);
      } else this.stats.duplicatesIn++;
      this.scheduleAck(true);
    }
    return true;
  }

  private accept(body: Buffer, partial = false): void {
    this.rcvNext = u32(this.rcvNext + body.length);
    if (partial) return; // a tail of a body can't be parsed on its own
    const parsed = parseBody(body);
    this.emit('body', parsed);
  }

  private onPeerAck(ack: number): void {
    if (!seqAfter(ack, this.sndUna)) return;
    if (seqAfter(ack, this.sndNext)) return; // acks bytes we never sent: ignore
    this.sndUna = ack;
    this.lastAckProgressAt = Date.now();
    while (this.outstanding.length) {
      const o = this.outstanding[0];
      const end = u32(o.offset + o.body.length);
      if (seqAfter(end, ack)) break;
      this.outstanding.shift();
    }
  }

  // ---------------------------------------------------------------- timers

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();

    for (const o of this.outstanding) {
      const rto = this.o.rtoMs * 2 ** o.tries;
      if (now - o.lastSentAt < rto) break; // later ones were sent after this one
      if (o.tries >= this.o.maxRetries) return this.close('peer stopped acknowledging');
      o.tries++;
      o.lastSentAt = now;
      this.stats.retransmitsOut++;
      this.o.log?.(`ptcp: retransmit offset ${o.offset} (${o.body.length} B, try ${o.tries})`);
      this.transmitBody(o.offset, o.pid, o.body);
    }

    if (this.outstanding.length && now - this.lastAckProgressAt > this.o.stallTimeoutMs) return this.close('stalled');
    if (now - this.lastHeardAt > this.o.idleTimeoutMs) return this.close('peer silent');
    if (this.heartbeats && now - this.lastHeartbeatAt >= this.o.heartbeatMs) {
      this.lastHeartbeatAt = now;
      this.send(bodies.heartbeat());
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closedReason = reason;
    clearInterval(this.ticker);
    this.cancelAck();
    this.o.log?.(`ptcp: session closed (${reason})`);
    this.emit('closed', reason);
  }
}

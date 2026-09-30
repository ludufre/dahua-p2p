"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PtcpSession = exports.seqAfter = exports.bodies = exports.MAX_DATA = exports.HEADER_SIZE = exports.BodyType = void 0;
exports.encodePacket = encodePacket;
exports.decodePacket = decodePacket;
exports.parseBody = parseBody;
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
const node_events_1 = require("node:events");
const node_crypto_1 = __importDefault(require("node:crypto"));
exports.BodyType = {
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
};
exports.HEADER_SIZE = 24;
/** Largest data chunk per datagram (what the devices themselves use). */
exports.MAX_DATA = 1280;
const UDP_OVERHEAD = 28;
function encodePacket(p) {
    const h = Buffer.alloc(exports.HEADER_SIZE);
    h.write('PTCP', 0, 'latin1');
    h.writeUInt32BE(p.sent >>> 0, 4);
    h.writeUInt32BE(p.recv >>> 0, 8);
    h.writeUInt32BE(p.pid >>> 0, 12);
    h.writeUInt32BE(p.lmid >>> 0, 16);
    h.writeUInt32BE(p.rmid >>> 0, 20);
    return Buffer.concat([h, p.body]);
}
/** null when the datagram is not PTCP (relay agents also send raw HTTP-like text). */
function decodePacket(buf) {
    if (buf.length < exports.HEADER_SIZE || buf.toString('latin1', 0, 4) !== 'PTCP')
        return null;
    return {
        sent: buf.readUInt32BE(4),
        recv: buf.readUInt32BE(8),
        pid: buf.readUInt32BE(12),
        lmid: buf.readUInt32BE(16),
        rmid: buf.readUInt32BE(20),
        body: buf.subarray(exports.HEADER_SIZE),
    };
}
// ------------------------------------------------------------------ bodies
const typeHeader = (type, len, realm) => {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(((type << 24) | (len & 0xffffff)) >>> 0, 0);
    b.writeUInt32BE(realm >>> 0, 4);
    return b;
};
exports.bodies = {
    sync: () => Buffer.from([0x00, 0x03, 0x01, 0x00]),
    heartbeat: () => typeHeader(exports.BodyType.Heartbeat, 0, 0),
    data: (realm, data) => Buffer.concat([typeHeader(exports.BodyType.Data, data.length, realm), data]),
    bind: (realm, port) => {
        const tail = Buffer.alloc(8);
        tail.writeUInt32BE(port >>> 0, 0);
        tail.writeUInt32BE(0x7f000001, 4); // 127.0.0.1 on the device side
        return Buffer.concat([typeHeader(exports.BodyType.Bind, 0, realm), tail]);
    },
    status: (realm, status) => Buffer.concat([typeHeader(exports.BodyType.Status, 4, realm), Buffer.from(status)]),
    command: (type, payload = Buffer.alloc(0)) => Buffer.concat([typeHeader(type, 0, 0), payload]),
};
function parseBody(b) {
    const code = b[0];
    if (code === exports.BodyType.Sync)
        return { type: 'sync' };
    if (b.length < 12)
        return { type: 'command', code, payload: b.subarray(4), raw: b };
    const realm = b.readUInt32BE(4);
    switch (code) {
        case exports.BodyType.Data: {
            const len = b.readUInt32BE(0) & 0xffffff;
            return { type: 'data', realm, data: b.subarray(12, 12 + len) };
        }
        case exports.BodyType.Bind:
            return { type: 'bind', realm, port: b.length >= 16 ? b.readUInt32BE(12) : 0 };
        case exports.BodyType.Status:
            return { type: 'status', realm, status: b.toString('latin1', 12) };
        case exports.BodyType.Heartbeat:
            return { type: 'heartbeat' };
        default:
            return { type: 'command', code, payload: b.subarray(12), raw: b };
    }
}
// ------------------------------------------------------------------ sequence math
const u32 = (n) => n >>> 0;
/** a comes after b in 32-bit wrap-around space. */
const seqAfter = (a, b) => {
    const d = u32(a - b);
    return d !== 0 && d < 0x80000000;
};
exports.seqAfter = seqAfter;
/**
 * Reliable, ordered PTCP stream with one peer.
 * Events: 'body' (Body), 'closed' (reason: string).
 */
class PtcpSession extends node_events_1.EventEmitter {
    sndNext = 0;
    sndUna = 0;
    count = 0;
    lmid = node_crypto_1.default.randomInt(1, 0x7fffffff);
    outstanding = [];
    rcvNext = 0;
    early = new Map();
    lastPeerLmid = 0;
    ackTimer = null;
    ticker;
    lastHeardAt = Date.now();
    lastHeartbeatAt = Date.now();
    lastAckProgressAt = Date.now();
    closedReason = null;
    stats = { datagramsIn: 0, datagramsOut: 0, retransmitsOut: 0, duplicatesIn: 0, outOfOrderIn: 0, gapsFilled: 0 };
    heartbeats = true;
    o;
    constructor(opts) {
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
    get closed() {
        return this.closedReason !== null;
    }
    /** Bytes of the peer's stream received in order (our ACK). */
    get received() {
        return this.rcvNext;
    }
    /** Our bytes still waiting for an ACK. */
    get unacked() {
        return u32(this.sndNext - this.sndUna);
    }
    // ---------------------------------------------------------------- output
    /** Queues a body for reliable delivery. */
    send(body) {
        if (this.closed)
            return;
        const isSync = body[0] === exports.BodyType.Sync && body.length === 4;
        const pid = isSync ? 0x0002ffff : u32(0xffff - (this.count & 0xffff));
        if (!isSync)
            this.count++;
        const o = { offset: this.sndNext, body, pid, firstSentAt: Date.now(), lastSentAt: Date.now(), tries: 0 };
        if (this.outstanding.length === 0)
            this.lastAckProgressAt = Date.now();
        this.outstanding.push(o);
        this.sndNext = u32(this.sndNext + body.length);
        this.transmitBody(o.offset, pid, body);
    }
    sendData(realm, data) {
        for (let i = 0; i < data.length; i += exports.MAX_DATA)
            this.send(exports.bodies.data(realm, data.subarray(i, i + exports.MAX_DATA)));
    }
    transmitBody(offset, pid, body) {
        this.cancelAck(); // every datagram carries our current ACK
        this.stats.datagramsOut++;
        this.o.transmit(encodePacket({ sent: offset, recv: this.rcvNext, pid, lmid: this.lmid++, rmid: this.lastPeerLmid, body }));
    }
    sendAck() {
        this.ackTimer = null;
        if (this.closed)
            return;
        this.stats.datagramsOut++;
        this.o.transmit(encodePacket({
            sent: this.sndNext,
            recv: this.rcvNext,
            pid: u32(0xffff - (this.count & 0xffff)),
            lmid: this.lmid++,
            rmid: this.lastPeerLmid,
            body: Buffer.alloc(0),
        }));
    }
    scheduleAck(immediate = false) {
        if (immediate) {
            this.cancelAck();
            this.sendAck();
        }
        else if (!this.ackTimer) {
            this.ackTimer = setTimeout(() => this.sendAck(), this.o.ackDelayMs);
        }
    }
    cancelAck() {
        if (this.ackTimer)
            clearTimeout(this.ackTimer);
        this.ackTimer = null;
    }
    // ---------------------------------------------------------------- input
    /** Feeds one datagram received from the peer. Returns false if it was not PTCP. */
    input(datagram) {
        const p = decodePacket(datagram);
        if (!p || this.closed)
            return !!p;
        this.stats.datagramsIn++;
        this.lastHeardAt = Date.now();
        this.lastPeerLmid = p.lmid;
        this.onPeerAck(p.recv);
        if (p.body.length === 0)
            return true;
        const len = p.body.length;
        if (p.sent === this.rcvNext) {
            this.accept(p.body);
            while (this.early.size) {
                const next = this.early.get(this.rcvNext);
                if (!next)
                    break;
                this.early.delete(this.rcvNext);
                this.stats.gapsFilled++;
                this.accept(next);
            }
            this.scheduleAck(this.early.size > 0);
        }
        else if ((0, exports.seqAfter)(p.sent, this.rcvNext)) {
            // A gap: keep it for later and tell the peer right away where we are
            if (!this.early.has(p.sent)) {
                this.stats.outOfOrderIn++;
                if (this.early.size < 4096)
                    this.early.set(p.sent, Buffer.from(p.body));
            }
            else
                this.stats.duplicatesIn++;
            this.scheduleAck(true);
        }
        else {
            const end = u32(p.sent + len);
            if ((0, exports.seqAfter)(end, this.rcvNext)) {
                // Overlaps what we have: take only the new tail (not seen from Dahua so far)
                this.accept(p.body.subarray(u32(this.rcvNext - p.sent)), true);
            }
            else
                this.stats.duplicatesIn++;
            this.scheduleAck(true);
        }
        return true;
    }
    accept(body, partial = false) {
        this.rcvNext = u32(this.rcvNext + body.length);
        if (partial)
            return; // a tail of a body can't be parsed on its own
        const parsed = parseBody(body);
        this.emit('body', parsed);
    }
    onPeerAck(ack) {
        if (!(0, exports.seqAfter)(ack, this.sndUna))
            return;
        if ((0, exports.seqAfter)(ack, this.sndNext))
            return; // acks bytes we never sent: ignore
        this.sndUna = ack;
        this.lastAckProgressAt = Date.now();
        while (this.outstanding.length) {
            const o = this.outstanding[0];
            const end = u32(o.offset + o.body.length);
            if ((0, exports.seqAfter)(end, ack))
                break;
            this.outstanding.shift();
        }
    }
    // ---------------------------------------------------------------- timers
    tick() {
        if (this.closed)
            return;
        const now = Date.now();
        for (const o of this.outstanding) {
            const rto = this.o.rtoMs * 2 ** o.tries;
            if (now - o.lastSentAt < rto)
                break; // later ones were sent after this one
            if (o.tries >= this.o.maxRetries)
                return this.close('peer stopped acknowledging');
            o.tries++;
            o.lastSentAt = now;
            this.stats.retransmitsOut++;
            this.o.log?.(`ptcp: retransmit offset ${o.offset} (${o.body.length} B, try ${o.tries})`);
            this.transmitBody(o.offset, o.pid, o.body);
        }
        if (this.outstanding.length && now - this.lastAckProgressAt > this.o.stallTimeoutMs)
            return this.close('stalled');
        if (now - this.lastHeardAt > this.o.idleTimeoutMs)
            return this.close('peer silent');
        if (this.heartbeats && now - this.lastHeartbeatAt >= this.o.heartbeatMs) {
            this.lastHeartbeatAt = now;
            this.send(exports.bodies.heartbeat());
        }
    }
    close(reason = 'closed') {
        if (this.closed)
            return;
        this.closedReason = reason;
        clearInterval(this.ticker);
        this.cancelAck();
        this.o.log?.(`ptcp: session closed (${reason})`);
        this.emit('closed', reason);
    }
}
exports.PtcpSession = PtcpSession;
//# sourceMappingURL=ptcp.js.map
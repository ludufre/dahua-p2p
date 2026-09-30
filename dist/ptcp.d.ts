import { EventEmitter } from 'node:events';
export declare const BodyType: {
    readonly Sync: 0;
    readonly Data: 16;
    readonly Bind: 17;
    readonly Status: 18;
    readonly Heartbeat: 19;
    readonly SignRequest: 23;
    readonly Sign: 24;
    readonly Auth: 25;
    readonly AuthAck: 26;
    readonly AuthFin: 27;
};
export declare const HEADER_SIZE = 24;
/** Largest data chunk per datagram (what the devices themselves use). */
export declare const MAX_DATA = 1280;
export interface PtcpPacket {
    sent: number;
    recv: number;
    pid: number;
    lmid: number;
    rmid: number;
    body: Buffer;
}
export declare function encodePacket(p: PtcpPacket): Buffer;
/** null when the datagram is not PTCP (relay agents also send raw HTTP-like text). */
export declare function decodePacket(buf: Buffer): PtcpPacket | null;
export declare const bodies: {
    sync: () => Buffer<ArrayBuffer>;
    heartbeat: () => Buffer<ArrayBuffer>;
    data: (realm: number, data: Buffer) => Buffer<ArrayBuffer>;
    bind: (realm: number, port: number) => Buffer<ArrayBuffer>;
    status: (realm: number, status: "CONN" | "DISC") => Buffer<ArrayBuffer>;
    command: (type: number, payload?: Buffer) => Buffer<ArrayBuffer>;
};
export type Body = {
    type: 'sync';
} | {
    type: 'data';
    realm: number;
    data: Buffer;
} | {
    type: 'bind';
    realm: number;
    port: number;
} | {
    type: 'status';
    realm: number;
    status: string;
} | {
    type: 'heartbeat';
} | {
    type: 'command';
    code: number;
    payload: Buffer;
    raw: Buffer;
};
export declare function parseBody(b: Buffer): Body;
/** a comes after b in 32-bit wrap-around space. */
export declare const seqAfter: (a: number, b: number) => boolean;
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
export declare class PtcpSession extends EventEmitter {
    private sndNext;
    private sndUna;
    private count;
    private lmid;
    private outstanding;
    private rcvNext;
    private early;
    private lastPeerLmid;
    private ackTimer;
    private ticker;
    private lastHeardAt;
    private lastHeartbeatAt;
    private lastAckProgressAt;
    private closedReason;
    readonly stats: PtcpStats;
    heartbeats: boolean;
    private readonly o;
    constructor(opts: PtcpSessionOptions);
    get closed(): boolean;
    /** Bytes of the peer's stream received in order (our ACK). */
    get received(): number;
    /** Our bytes still waiting for an ACK. */
    get unacked(): number;
    /** Queues a body for reliable delivery. */
    send(body: Buffer): void;
    sendData(realm: number, data: Buffer): void;
    private transmitBody;
    private sendAck;
    private scheduleAck;
    private cancelAck;
    /** Feeds one datagram received from the peer. Returns false if it was not PTCP. */
    input(datagram: Buffer): boolean;
    private accept;
    private onPeerAck;
    private tick;
    close(reason?: string): void;
}

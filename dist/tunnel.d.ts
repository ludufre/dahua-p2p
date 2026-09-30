import { Duplex } from 'node:stream';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Logger } from './dhhttp.js';
import { HandshakeResult } from './handshake.js';
import { PtcpSession, PtcpStats } from './ptcp.js';
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
declare class Realm extends Duplex {
    readonly id: number;
    private tunnel;
    private finished;
    constructor(id: number, tunnel: Tunnel);
    _read(): void;
    _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void;
    _final(cb: (err?: Error | null) => void): void;
    _destroy(err: Error | null, cb: (err?: Error | null) => void): void;
    /** Called by the tunnel when the device closes this realm. */
    remoteClosed(): void;
}
/** Events: 'closed' (reason) */
export declare class Tunnel extends EventEmitter {
    private sock;
    readonly session: PtcpSession;
    readonly handshake: HandshakeResult;
    private log?;
    private realms;
    private pendingBinds;
    private pendingDiscs;
    /** Dahua handles one realm at a time: the next bind waits for the previous DISC. */
    private gate;
    private closeReason;
    private constructor();
    static open(opts: TunnelOptions): Promise<Tunnel>;
    get closed(): boolean;
    get stats(): TunnelStats;
    /** Opens a TCP connection to `port` on the device (default RTSP). */
    connect(port?: number): Promise<Duplex>;
    /** Exposes `remotePort` on the device as a local TCP port (for ffmpeg, VLC…). */
    listen(localPort: number, remotePort?: number, host?: string): Promise<net.Server>;
    /** Ends a realm on our side (called by the Realm stream). */
    disconnect(realm: Realm): void;
    private onBody;
    close(reason?: string): void;
}
export declare function openTunnel(opts: TunnelOptions): Promise<Tunnel>;
export {};

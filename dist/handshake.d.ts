import { DhSocket, Endpoint, Logger } from './dhhttp.js';
import { DeviceInfo } from './crypto.js';
import { PtcpSession } from './ptcp.js';
export interface HandshakeResult {
    peer: Endpoint;
    session: PtcpSession;
    info: DeviceInfo | null;
    /** Device addresses as reported by the cloud (for diagnostics / direct mode). */
    device: {
        localAddr?: string;
        pubAddr?: string;
    };
    timings: Record<string, number>;
}
export declare class DeviceAuthRequired extends Error {
    constructor();
}
/**
 * The relay agent never confirmed that the device joined. Devices take one relay
 * session at a time and keep a closed one for ~15–20 s (until its heartbeats time
 * out), so this is what a new tunnel sees right after another one — or while
 * another client (e.g. the vendor app) holds the relay.
 */
export declare class DeviceBusy extends Error {
    constructor();
}
export declare function relayHandshake(sock: DhSocket, serial: string, opts?: {
    log?: Logger;
    timeoutMs?: number;
    joinTimeoutMs?: number;
    cloud?: string;
}): Promise<HandshakeResult>;

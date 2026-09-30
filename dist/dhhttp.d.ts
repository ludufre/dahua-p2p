import dgram from 'node:dgram';
/** Client credentials shared by every Dahua client (recovered from SmartPSS Lite). */
export declare const EASY4IP: {
    server: string;
    username: string;
    userkey: string;
};
export interface DhResponse {
    code: number;
    status: string;
    headers: Record<string, string>;
    /** Flattened XML body: `<body><US>1.2.3.4:8803</US></body>` → `{ 'body/US': '1.2.3.4:8803' }` */
    body: Record<string, string>;
    raw: string;
}
export interface Endpoint {
    host: string;
    port: number;
}
export type Logger = (msg: string) => void;
export declare function resolveEndpoint(addr: string): Promise<Endpoint>;
export declare function sameEndpoint(a: Endpoint, rinfo: {
    address: string;
    port: number;
}): boolean;
/** Minimal flat XML reader: nested tags joined by "/", text nodes only. */
export declare function parseXmlFlat(xml: string): Record<string, string>;
export declare function parseDhResponse(raw: string): DhResponse;
export declare function buildDhRequest(path: string, cseq: number, body?: string): Buffer;
/**
 * A UDP socket that speaks DH-HTTP with several peers. Incoming datagrams are
 * matched to pending requests by source address; anything else (PTCP, STUN) goes
 * to `onOther`, so the same local port can carry the handshake and the tunnel.
 */
export declare class DhSocket {
    private log?;
    readonly sock: dgram.Socket;
    private cseq;
    private waiters;
    /** Responses that arrived before anyone asked (the cloud answers some requests late). */
    private early;
    onOther: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | null;
    bytesIn: number;
    bytesOut: number;
    private closed;
    constructor(log?: Logger | undefined);
    bind(): Promise<number>;
    get localPort(): number;
    send(to: Endpoint, data: Buffer): void;
    /** Sends a request without waiting; returns its CSeq (answer collected later with `read`). */
    request(to: Endpoint, path: string, body?: string): number;
    /** Waits for the next response from `from` (final or provisional), optionally for given CSeqs. */
    read(from: Endpoint, timeoutMs: number, cseqs?: number[] | null): Promise<DhResponse>;
    /** Waits for a final (>= 200) response, skipping provisional ones. */
    readFinal(from: Endpoint, timeoutMs: number, cseqs?: number[] | null): Promise<DhResponse>;
    /** Request + final response, retried on timeout (UDP). Throws on >= 300. */
    call(to: Endpoint, path: string, body?: string, { timeoutMs, tries }?: {
        timeoutMs?: number | undefined;
        tries?: number | undefined;
    }): Promise<DhResponse>;
    close(): void;
}

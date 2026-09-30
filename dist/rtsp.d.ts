import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
export type Codec = 'h264' | 'h265';
export interface VideoFrame {
    /** Annex B access unit (start codes + NALs); keyframes carry the parameter sets. */
    data: Buffer;
    keyframe: boolean;
    codec: Codec;
    /** RTP timestamp (90 kHz). */
    timestamp: number;
}
export interface RtspOptions {
    /** e.g. rtsp://device/cam/realmonitor?channel=1&subtype=1 (the host part is not used for routing). */
    url: string;
    user?: string;
    pass?: string;
    log?: (msg: string) => void;
    timeoutMs?: number;
}
interface VideoTrack {
    control: string;
    payloadType: number;
    codec: Codec;
    /** Parameter sets from the SDP (SPS/PPS, + VPS for H.265), prepended to keyframes that lack them. */
    paramSets: Buffer[];
}
export declare function parseSdpVideo(sdp: string): VideoTrack | null;
/** RTP → access units. Drops a frame when a fragment of it went missing. */
export declare class Depacketizer {
    private track;
    private onFrame;
    private nals;
    private fu;
    private timestamp;
    private lastSeq;
    private broken;
    constructor(track: VideoTrack, onFrame: (f: VideoFrame) => void);
    push(rtp: Buffer): void;
    private h264;
    private h265;
    private aggregated;
    private flush;
}
/** Events: 'frame' (VideoFrame), 'close' (error?) */
export declare class RtspClient extends EventEmitter {
    private stream;
    private o;
    private buf;
    private cseq;
    private pending;
    private auth;
    private session;
    private keepalive;
    private depacketizer;
    private closed;
    track: VideoTrack | null;
    bytesIn: number;
    constructor(stream: Duplex, o: RtspOptions);
    /** DESCRIBE → SETUP (video, interleaved) → PLAY. Frames start flowing right after. */
    start(): Promise<VideoTrack>;
    /** TEARDOWN (best effort) and close the connection; resolves once it is closed. */
    close(): Promise<void>;
    private finish;
    private authorization;
    private send;
    private request;
    private exchange;
    private onData;
}
export {};

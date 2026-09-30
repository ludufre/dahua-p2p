import { RtspClient, RtspOptions, VideoFrame } from './rtsp.js';
import type { Tunnel } from './tunnel.js';
export interface CameraRtspOptions extends Omit<RtspOptions, 'url'> {
    /** Path + query on the device, default the Dahua sub stream of channel 1. */
    path?: string;
    channel?: number;
    subtype?: number;
    port?: number;
}
export declare function dahuaRtspUrl(o: CameraRtspOptions): string;
/** Opens RTSP through the tunnel and starts playing (listen to 'frame'). */
export declare function openRtsp(tunnel: Tunnel, o: CameraRtspOptions): Promise<RtspClient>;
/** Bytes on the wire (both directions, IP/UDP included) since the tunnel opened. */
export declare const tunnelBytes: (t: Tunnel) => number;
/**
 * One photo: RTSP → first keyframe → TEARDOWN. The tunnel stays open for the next one.
 * `bytes` is what the photo cost on the wire, including what arrived after TEARDOWN.
 */
export declare function captureKeyframe(tunnel: Tunnel, o: CameraRtspOptions & {
    timeoutMs?: number;
}): Promise<{
    frame: VideoFrame;
    bytes: number;
    ms: number;
}>;

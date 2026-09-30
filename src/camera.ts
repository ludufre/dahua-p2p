// High-level helpers: live video and single keyframes through a tunnel.
import { RtspClient, RtspOptions, VideoFrame } from './rtsp.js';
import type { Tunnel } from './tunnel.js';

export interface CameraRtspOptions extends Omit<RtspOptions, 'url'> {
  /** Path + query on the device, default the Dahua sub stream of channel 1. */
  path?: string;
  channel?: number;
  subtype?: number;
  port?: number;
}

export function dahuaRtspUrl(o: CameraRtspOptions): string {
  const path = o.path || `/cam/realmonitor?channel=${o.channel ?? 1}&subtype=${o.subtype ?? 1}`;
  return `rtsp://127.0.0.1${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Opens RTSP through the tunnel and starts playing (listen to 'frame'). */
export async function openRtsp(tunnel: Tunnel, o: CameraRtspOptions): Promise<RtspClient> {
  const stream = await tunnel.connect(o.port ?? 554);
  const client = new RtspClient(stream, { ...o, url: dahuaRtspUrl(o) });
  try {
    await client.start();
    return client;
  } catch (err) {
    void client.close();
    throw err;
  }
}

/** Bytes on the wire (both directions, IP/UDP included) since the tunnel opened. */
export const tunnelBytes = (t: Tunnel) => t.stats.udpBytesIn + t.stats.udpBytesOut;

/** Video the device already put on the wire keeps arriving after TEARDOWN (one relay RTT). */
const SETTLE_MS = 500;

/**
 * One photo: RTSP → first keyframe → TEARDOWN. The tunnel stays open for the next one.
 * `bytes` is what the photo cost on the wire, including what arrived after TEARDOWN.
 */
export async function captureKeyframe(
  tunnel: Tunnel,
  o: CameraRtspOptions & { timeoutMs?: number },
): Promise<{ frame: VideoFrame; bytes: number; ms: number }> {
  const before = tunnelBytes(tunnel);
  const t0 = Date.now();
  const client = await openRtsp(tunnel, o);
  try {
    const frame = await new Promise<VideoFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no keyframe in time')), o.timeoutMs ?? 10_000);
      client.on('frame', (f: VideoFrame) => {
        if (!f.keyframe) return;
        clearTimeout(timer);
        resolve(f);
      });
      client.on('close', (err?: Error) => {
        clearTimeout(timer);
        reject(err || new Error('RTSP closed before a keyframe'));
      });
    });
    const ms = Date.now() - t0;
    await client.close();
    await new Promise(r => setTimeout(r, SETTLE_MS));
    return { frame, bytes: tunnelBytes(tunnel) - before, ms };
  } finally {
    void client.close();
  }
}

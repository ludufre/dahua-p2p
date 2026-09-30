"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tunnelBytes = void 0;
exports.dahuaRtspUrl = dahuaRtspUrl;
exports.openRtsp = openRtsp;
exports.captureKeyframe = captureKeyframe;
// High-level helpers: live video and single keyframes through a tunnel.
const rtsp_js_1 = require("./rtsp.js");
function dahuaRtspUrl(o) {
    const path = o.path || `/cam/realmonitor?channel=${o.channel ?? 1}&subtype=${o.subtype ?? 1}`;
    return `rtsp://127.0.0.1${path.startsWith('/') ? '' : '/'}${path}`;
}
/** Opens RTSP through the tunnel and starts playing (listen to 'frame'). */
async function openRtsp(tunnel, o) {
    const stream = await tunnel.connect(o.port ?? 554);
    const client = new rtsp_js_1.RtspClient(stream, { ...o, url: dahuaRtspUrl(o) });
    try {
        await client.start();
        return client;
    }
    catch (err) {
        void client.close();
        throw err;
    }
}
/** Bytes on the wire (both directions, IP/UDP included) since the tunnel opened. */
const tunnelBytes = (t) => t.stats.udpBytesIn + t.stats.udpBytesOut;
exports.tunnelBytes = tunnelBytes;
/** Video the device already put on the wire keeps arriving after TEARDOWN (one relay RTT). */
const SETTLE_MS = 500;
/**
 * One photo: RTSP → first keyframe → TEARDOWN. The tunnel stays open for the next one.
 * `bytes` is what the photo cost on the wire, including what arrived after TEARDOWN.
 */
async function captureKeyframe(tunnel, o) {
    const before = (0, exports.tunnelBytes)(tunnel);
    const t0 = Date.now();
    const client = await openRtsp(tunnel, o);
    try {
        const frame = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no keyframe in time')), o.timeoutMs ?? 10_000);
            client.on('frame', (f) => {
                if (!f.keyframe)
                    return;
                clearTimeout(timer);
                resolve(f);
            });
            client.on('close', (err) => {
                clearTimeout(timer);
                reject(err || new Error('RTSP closed before a keyframe'));
            });
        });
        const ms = Date.now() - t0;
        await client.close();
        await new Promise(r => setTimeout(r, SETTLE_MS));
        return { frame, bytes: (0, exports.tunnelBytes)(tunnel) - before, ms };
    }
    finally {
        void client.close();
    }
}
//# sourceMappingURL=camera.js.map
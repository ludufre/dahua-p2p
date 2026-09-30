#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_child_process_1 = require("node:child_process");
const commander_1 = require("commander");
const tunnel_js_1 = require("./tunnel.js");
const camera_js_1 = require("./camera.js");
const program = new commander_1.Command();
program.name('dahua-p2p').description('Dahua/Intelbras (Easy4ip) P2P tunnel');
const logger = (verbose) => (verbose ? (m) => console.error(`[${new Date().toISOString().slice(11, 23)}] ${m}`) : undefined);
program
    .command('tunnel')
    .description('expose a device port (default RTSP) on a local TCP port through the cloud relay')
    .argument('<serial>', 'device serial number')
    .option('-l, --listen <port>', 'local port', '1554')
    .option('-r, --remote <port>', 'device port', '554')
    .option('--host <host>', 'local bind address', '127.0.0.1')
    .option('-v, --verbose', 'log the handshake and PTCP events')
    .action(async (serial, o) => {
    const log = logger(!!o.verbose);
    const tunnel = await (0, tunnel_js_1.openTunnel)({ serial, log });
    await tunnel.listen(Number(o.listen), Number(o.remote), o.host);
    console.error(`tunnel ready in ${tunnel.stats.handshakeMs} ms: ${o.host}:${o.listen} → ${serial}:${o.remote}`);
    const timer = setInterval(() => console.error(`stats ${JSON.stringify(tunnel.stats)}`), 5000);
    tunnel.on('closed', reason => {
        clearInterval(timer);
        console.error(`tunnel closed: ${reason}`);
        process.exit(1);
    });
    process.on('SIGINT', () => tunnel.close('interrupted'));
    process.on('SIGTERM', () => tunnel.close('terminated'));
});
const camOptions = (o, log) => ({
    user: o.user,
    pass: o.pass,
    channel: Number(o.channel),
    subtype: Number(o.subtype),
    path: o.path,
    log,
});
const withCamOptions = (c) => c
    .argument('<serial>', 'device serial number')
    .option('-u, --user <user>', 'device user', 'admin')
    .option('-p, --pass <pass>', 'device password')
    .option('-c, --channel <n>', 'channel', '1')
    .option('-s, --subtype <n>', 'stream: 0 main, 1 sub', '1')
    .option('--path <path>', 'custom RTSP path (overrides channel/subtype)')
    .option('-v, --verbose', 'log the handshake, PTCP and RTSP');
function writeFrame(frame, out) {
    if (!out.endsWith('.jpg'))
        return node_fs_1.default.writeFileSync(out, frame.data);
    const r = (0, node_child_process_1.spawnSync)('ffmpeg', ['-loglevel', 'error', '-y', '-f', frame.codec === 'h264' ? 'h264' : 'hevc', '-i', 'pipe:0', '-frames:v', '1', out], {
        input: frame.data,
    });
    if (r.status !== 0)
        throw new Error(`ffmpeg failed: ${r.stderr?.toString() || r.error?.message}`);
}
withCamOptions(program.command('snapshot').description('take photos (first keyframe) and report what each one cost on the wire'))
    .option('-o, --out <file>', 'save the first photo (.jpg needs ffmpeg; anything else = raw Annex B)')
    .option('-n, --count <n>', 'number of photos', '1')
    .option('-i, --interval <s>', 'seconds between photos (same tunnel)', '5')
    .action(async (serial, o) => {
    const log = logger(!!o.verbose);
    const tunnel = await (0, tunnel_js_1.openTunnel)({ serial, log });
    console.error(`tunnel ready in ${tunnel.stats.handshakeMs} ms (${tunnel.stats.udpBytesIn + tunnel.stats.udpBytesOut} B)`);
    let ok = 0;
    const count = Number(o.count);
    for (let i = 1; i <= count; i++) {
        try {
            const { frame, bytes, ms } = await (0, camera_js_1.captureKeyframe)(tunnel, camOptions(o, log));
            ok++;
            console.log(`photo ${i}: ${frame.codec} keyframe ${frame.data.length} B in ${ms} ms, wire cost ${bytes} B`);
            if (i === 1 && o.out)
                writeFrame(frame, o.out);
        }
        catch (err) {
            console.log(`photo ${i}: FAILED ${err.message}`);
            if (tunnel.closed)
                break;
        }
        if (i < count)
            await new Promise(r => setTimeout(r, Number(o.interval) * 1000));
    }
    console.log(`${ok}/${count} photos; tunnel ${JSON.stringify(tunnel.stats)}`);
    tunnel.close('done');
    process.exit(ok === count ? 0 : 1);
});
withCamOptions(program.command('soak').description('stream live video and report frame rate / stalls'))
    .option('-m, --minutes <n>', 'duration', '5')
    .action(async (serial, o) => {
    const log = logger(!!o.verbose);
    const tunnel = await (0, tunnel_js_1.openTunnel)({ serial, log });
    const client = await (0, camera_js_1.openRtsp)(tunnel, camOptions(o, log));
    let frames = 0;
    let keyframes = 0;
    let lastFrameAt = Date.now();
    let worstGap = 0;
    client.on('frame', (f) => {
        const now = Date.now();
        worstGap = Math.max(worstGap, now - lastFrameAt);
        lastFrameAt = now;
        frames++;
        if (f.keyframe)
            keyframes++;
    });
    const t0 = Date.now();
    const end = t0 + Number(o.minutes) * 60_000;
    const report = () => `${Math.round((Date.now() - t0) / 1000)}s frames=${frames} key=${keyframes} worstGap=${worstGap}ms ` +
        `kbps=${Math.round(((tunnel.stats.udpBytesIn + tunnel.stats.udpBytesOut) * 8) / (Date.now() - t0))} ptcp=${JSON.stringify(tunnel.stats.ptcp)}`;
    const failed = await new Promise(resolve => {
        const timer = setInterval(() => {
            console.log(report());
            if (Date.now() - lastFrameAt > 5000)
                resolve('STALLED (no frame for 5 s)');
            else if (Date.now() >= end)
                resolve(null);
        }, 5000);
        client.on('close', (err) => resolve(`RTSP closed: ${err?.message}`));
        tunnel.on('closed', reason => resolve(`tunnel closed: ${reason}`));
        void timer;
    });
    console.log(failed ? `FAIL ${failed}` : `OK ${report()}`);
    tunnel.close('done');
    process.exit(failed ? 1 : 0);
});
program.parseAsync().catch(err => {
    console.error(err?.message || err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map
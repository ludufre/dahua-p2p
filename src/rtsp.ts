// Minimal RTSP client over any byte stream (a tunnel realm, or a plain TCP socket).
// Video only, RTP interleaved over the same connection, H.264 / H.265 depacketized
// into Annex B access units — the shape the Vizor decoders already consume.
import crypto from 'node:crypto';
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

interface RtspResponse {
  code: number;
  status: string;
  headers: Record<string, string>;
  body: string;
}

interface VideoTrack {
  control: string;
  payloadType: number;
  codec: Codec;
  /** Parameter sets from the SDP (SPS/PPS, + VPS for H.265), prepended to keyframes that lack them. */
  paramSets: Buffer[];
}

const START = Buffer.from([0, 0, 0, 1]);

export function parseSdpVideo(sdp: string): VideoTrack | null {
  const lines = sdp.split(/\r?\n/);
  let inVideo = false;
  let control = '';
  let payloadType = -1;
  let codec: Codec | null = null;
  let fmtp = '';
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (inVideo) break;
      inVideo = line.startsWith('m=video');
      if (inVideo) payloadType = Number(line.split(' ')[3]);
      continue;
    }
    if (!inVideo) continue;
    if (line.startsWith('a=control:')) control = line.slice(10).trim();
    const rtpmap = /^a=rtpmap:(\d+)\s+([A-Za-z0-9]+)\//.exec(line);
    if (rtpmap && Number(rtpmap[1]) === payloadType) {
      const name = rtpmap[2].toUpperCase();
      codec = name === 'H264' ? 'h264' : name === 'H265' || name === 'HEVC' ? 'h265' : null;
    }
    if (line.startsWith(`a=fmtp:${payloadType} `)) fmtp = line.slice(line.indexOf(' ') + 1);
  }
  if (!inVideo && !codec) return null;
  if (!codec) return null;
  const params: Record<string, string> = {};
  for (const kv of fmtp.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  const b64 = (s?: string) => (s ? s.split(',').filter(Boolean).map(x => Buffer.from(x, 'base64')) : []);
  const paramSets =
    codec === 'h264'
      ? b64(params['sprop-parameter-sets'])
      : [...b64(params['sprop-vps']), ...b64(params['sprop-sps']), ...b64(params['sprop-pps'])];
  return { control, payloadType, codec, paramSets };
}

const nalType = (codec: Codec, nal: Buffer) => (codec === 'h264' ? nal[0] & 0x1f : (nal[0] >> 1) & 0x3f);
const isKeyNal = (codec: Codec, t: number) => (codec === 'h264' ? t === 5 : t >= 16 && t <= 21);
const isParamNal = (codec: Codec, t: number) => (codec === 'h264' ? t === 7 || t === 8 : t >= 32 && t <= 34);

/** RTP → access units. Drops a frame when a fragment of it went missing. */
export class Depacketizer {
  private nals: Buffer[] = [];
  private fu: Buffer[] | null = null;
  private timestamp: number | null = null;
  private lastSeq: number | null = null;
  private broken = false;

  constructor(
    private track: VideoTrack,
    private onFrame: (f: VideoFrame) => void,
  ) {}

  push(rtp: Buffer): void {
    if (rtp.length < 12 || rtp[0] >> 6 !== 2) return;
    const csrc = rtp[0] & 0x0f;
    const hasExt = (rtp[0] & 0x10) !== 0;
    const padding = (rtp[0] & 0x20) !== 0;
    const marker = (rtp[1] & 0x80) !== 0;
    const pt = rtp[1] & 0x7f;
    if (pt !== this.track.payloadType) return;
    const seq = rtp.readUInt16BE(2);
    const ts = rtp.readUInt32BE(4);
    let off = 12 + csrc * 4;
    if (hasExt && rtp.length >= off + 4) off += 4 + rtp.readUInt16BE(off + 2) * 4;
    let end = rtp.length;
    if (padding) end -= rtp[rtp.length - 1];
    if (off >= end) return;
    const payload = rtp.subarray(off, end);

    if (this.lastSeq !== null && ((this.lastSeq + 1) & 0xffff) !== seq) this.broken = true;
    this.lastSeq = seq;
    if (this.timestamp !== null && ts !== this.timestamp) this.flush();
    this.timestamp = ts;

    if (this.track.codec === 'h264') this.h264(payload);
    else this.h265(payload);
    if (marker) this.flush();
  }

  private h264(p: Buffer): void {
    const t = p[0] & 0x1f;
    if (t >= 1 && t <= 23) return void this.nals.push(p);
    if (t === 24) return this.aggregated(p.subarray(1));
    if (t === 28 && p.length > 2) {
      const fuh = p[1];
      if (fuh & 0x80) this.fu = [Buffer.from([(p[0] & 0xe0) | (fuh & 0x1f)])];
      else if (!this.fu) return void (this.broken = true);
      this.fu.push(p.subarray(2));
      if (fuh & 0x40) {
        this.nals.push(Buffer.concat(this.fu));
        this.fu = null;
      }
    }
  }

  private h265(p: Buffer): void {
    if (p.length < 3) return;
    const t = (p[0] >> 1) & 0x3f;
    if (t === 48) return this.aggregated(p.subarray(2));
    if (t === 49) {
      const fuh = p[2];
      if (fuh & 0x80) this.fu = [Buffer.from([(p[0] & 0x81) | ((fuh & 0x3f) << 1), p[1]])];
      else if (!this.fu) return void (this.broken = true);
      this.fu.push(p.subarray(3));
      if (fuh & 0x40) {
        this.nals.push(Buffer.concat(this.fu));
        this.fu = null;
      }
      return;
    }
    this.nals.push(p);
  }

  private aggregated(p: Buffer): void {
    let i = 0;
    while (i + 2 <= p.length) {
      const size = p.readUInt16BE(i);
      i += 2;
      if (i + size > p.length) break;
      this.nals.push(p.subarray(i, i + size));
      i += size;
    }
  }

  private flush(): void {
    const nals = this.nals;
    const broken = this.broken || this.fu !== null;
    this.nals = [];
    this.fu = null;
    this.broken = false;
    if (!nals.length || broken) return;
    const codec = this.track.codec;
    const types = nals.map(n => nalType(codec, n));
    const keyframe = types.some(t => isKeyNal(codec, t));
    const parts: Buffer[] = [];
    if (keyframe && !types.some(t => isParamNal(codec, t))) for (const ps of this.track.paramSets) parts.push(START, ps);
    for (const n of nals) parts.push(START, n);
    this.onFrame({ data: Buffer.concat(parts), keyframe, codec, timestamp: this.timestamp ?? 0 });
  }
}

/** Events: 'frame' (VideoFrame), 'close' (error?) */
export class RtspClient extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private cseq = 0;
  private pending: { cseq: number; resolve: (r: RtspResponse) => void; reject: (e: Error) => void } | null = null;
  private auth: { realm: string; nonce: string; basic: boolean } | null = null;
  private session = '';
  private keepalive: NodeJS.Timeout | null = null;
  private depacketizer: Depacketizer | null = null;
  private closed = false;
  track: VideoTrack | null = null;
  bytesIn = 0;

  constructor(
    private stream: Duplex,
    private o: RtspOptions,
  ) {
    super();
    stream.on('data', (d: Buffer) => this.onData(d));
    stream.on('close', () => this.finish(new Error('connection closed')));
    stream.on('error', err => this.finish(err));
  }

  /** DESCRIBE → SETUP (video, interleaved) → PLAY. Frames start flowing right after. */
  async start(): Promise<VideoTrack> {
    const desc = await this.request('DESCRIBE', this.o.url, { Accept: 'application/sdp' });
    const track = parseSdpVideo(desc.body);
    if (!track) throw new Error('no H.264/H.265 video track in the SDP');
    this.track = track;
    const base = desc.headers['content-base'] || desc.headers['content-location'] || this.o.url;
    const controlUrl = /^rtsp:\/\//i.test(track.control)
      ? track.control
      : track.control && track.control !== '*'
        ? base.replace(/\/?$/, '/') + track.control
        : base;
    const setup = await this.request('SETUP', controlUrl, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    this.session = (setup.headers.session || '').split(';')[0];
    const timeout = Number(/timeout=(\d+)/.exec(setup.headers.session || '')?.[1] || 60);
    this.depacketizer = new Depacketizer(track, f => this.emit('frame', f));
    await this.request('PLAY', base, { Range: 'npt=0.000-' });
    this.keepalive = setInterval(() => {
      this.request('OPTIONS', this.o.url).catch(() => {});
    }, Math.max(10, timeout / 2) * 1000);
    this.keepalive.unref?.();
    return track;
  }

  /** TEARDOWN (best effort) and close the connection; resolves once it is closed. */
  close(): Promise<void> {
    const closed = new Promise<void>(resolve => {
      if (this.stream.destroyed) return resolve();
      this.stream.once('close', () => resolve());
    });
    if (!this.closed) {
      if (this.session) this.send('TEARDOWN', this.o.url, {});
      this.finish();
      this.stream.end();
      setTimeout(() => this.stream.destroy(), 500).unref?.();
    }
    return closed;
  }

  private finish(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.pending?.reject(err || new Error('closed'));
    this.pending = null;
    this.emit('close', err);
  }

  private authorization(method: string, url: string): string | undefined {
    if (!this.auth || this.o.user === undefined) return undefined;
    const user = this.o.user;
    const pass = this.o.pass ?? '';
    if (this.auth.basic) return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${user}:${this.auth.realm}:${pass}`);
    const ha2 = md5(`${method}:${url}`);
    const response = md5(`${ha1}:${this.auth.nonce}:${ha2}`);
    return `Digest username="${user}", realm="${this.auth.realm}", nonce="${this.auth.nonce}", uri="${url}", response="${response}"`;
  }

  private send(method: string, url: string, headers: Record<string, string>): number {
    const cseq = ++this.cseq;
    const auth = this.authorization(method, url);
    let req = `${method} ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: dahua-p2p\r\n`;
    if (this.session) req += `Session: ${this.session}\r\n`;
    if (auth) req += `Authorization: ${auth}\r\n`;
    for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
    this.o.log?.(`rtsp >>> ${method} ${url}`);
    this.stream.write(req + '\r\n');
    return cseq;
  }

  private async request(method: string, url: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.exchange(method, url, headers);
      if (res.code === 401 && attempt === 0 && this.o.user !== undefined) {
        const h = res.headers['www-authenticate'] || '';
        this.auth = {
          basic: /^Basic/i.test(h),
          realm: /realm="([^"]*)"/.exec(h)?.[1] || '',
          nonce: /nonce="([^"]*)"/.exec(h)?.[1] || '',
        };
        continue;
      }
      if (res.code >= 300) throw new Error(`RTSP ${method}: ${res.code} ${res.status}`);
      return res;
    }
    throw new Error(`RTSP ${method}: unauthorized (user/password)`);
  }

  private exchange(method: string, url: string, headers: Record<string, string>): Promise<RtspResponse> {
    if (this.closed) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.cseq === cseq) this.pending = null;
        reject(new Error(`RTSP ${method}: timeout`));
      }, this.o.timeoutMs ?? 10_000);
      const cseq = this.send(method, url, headers);
      this.pending = {
        cseq,
        resolve: r => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private onData(d: Buffer): void {
    this.bytesIn += d.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length === 0) return;
      if (this.buf[0] === 0x24) {
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        const channel = this.buf[1];
        const packet = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        if (channel === 0) this.depacketizer?.push(packet);
        continue;
      }
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd < 0) {
        if (this.buf.length > 64 * 1024) this.finish(new Error('garbage on the RTSP connection'));
        return;
      }
      const head = this.buf.toString('latin1', 0, headEnd);
      if (!head.startsWith('RTSP/')) {
        // Out of sync (should not happen on a reliable stream): resync on the next '$'
        const next = this.buf.indexOf(0x24, 1);
        this.buf = next < 0 ? Buffer.alloc(0) : this.buf.subarray(next);
        continue;
      }
      const lines = head.split('\r\n');
      const m = /^RTSP\/\d\.\d\s+(\d+)\s*(.*)$/.exec(lines[0]);
      const hdrs: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const len = Number(hdrs['content-length'] || 0);
      if (this.buf.length < headEnd + 4 + len) return;
      const body = this.buf.toString('utf8', headEnd + 4, headEnd + 4 + len);
      this.buf = this.buf.subarray(headEnd + 4 + len);
      const res: RtspResponse = { code: Number(m?.[1] || 0), status: m?.[2] || '', headers: hdrs, body };
      this.o.log?.(`rtsp <<< ${res.code} ${res.status}`);
      const p = this.pending;
      if (p && Number(hdrs.cseq) === p.cseq) {
        this.pending = null;
        p.resolve(res);
      }
    }
  }
}

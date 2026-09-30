// DH-HTTP: the HTTP-like request/response protocol the Easy4ip cloud speaks over UDP.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';

/** Client credentials shared by every Dahua client (recovered from SmartPSS Lite). */
export const EASY4IP = {
  server: 'www.easy4ipcloud.com:8800',
  username: 'cba1b29e32cb17aa46b8ff9e73c7f40b',
  userkey: '996103384cdf19179e19243e959bbf8b',
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

export async function resolveEndpoint(addr: string): Promise<Endpoint> {
  const i = addr.lastIndexOf(':');
  const host = addr.slice(0, i);
  const port = Number(addr.slice(i + 1));
  if (!host || !port) throw new Error(`bad address "${addr}"`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { host, port };
  const { address } = await dns.lookup(host, { family: 4 });
  return { host: address, port };
}

export function sameEndpoint(a: Endpoint, rinfo: { address: string; port: number }): boolean {
  return a.host === rinfo.address && a.port === rinfo.port;
}

/** Minimal flat XML reader: nested tags joined by "/", text nodes only. */
export function parseXmlFlat(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z0-9_:.-]+)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) {
      const text = m[4].trim();
      if (text && stack.length) out[stack.join('/')] = text;
    } else if (m[1]) {
      stack.pop();
    } else if (!m[3]) {
      stack.push(m[2]);
    }
  }
  return out;
}

export function parseDhResponse(raw: string): DhResponse {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const bodyText = split >= 0 ? raw.slice(split + 4) : '';
  const [statusLine, ...lines] = head.split('\r\n');
  const m = /^\S+\s+(\d+)\s*(.*)$/.exec(statusLine);
  if (!m) throw new Error(`bad DH response: ${statusLine}`);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { code: Number(m[1]), status: m[2], headers, body: parseXmlFlat(bodyText), raw };
}

function wsseHeader(): string {
  const nonce = crypto.randomInt(0, 2 ** 31);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = crypto
    .createHash('sha1')
    .update(`${nonce}${created}DHP2P:${EASY4IP.username}:${EASY4IP.userkey}`)
    .digest('base64');
  return (
    'Authorization: WSSE profile="UsernameToken"\r\n' +
    `X-WSSE: UsernameToken Username="${EASY4IP.username}", PasswordDigest="${digest}", Nonce="${nonce}", Created="${created}"\r\n`
  );
}

export function buildDhRequest(path: string, cseq: number, body?: string): Buffer {
  const method = body === undefined ? 'DHGET' : 'DHPOST';
  return Buffer.from(`${method} ${path} HTTP/1.1\r\nCSeq: ${cseq}\r\n${wsseHeader()}\r\n${body ?? ''}`);
}

/** Responses without a CSeq header (some relay agents omit it) match any request. */
function matchesCseq(res: DhResponse, cseqs: number[] | null): boolean {
  if (!cseqs || res.headers.CSeq === undefined) return true;
  return cseqs.includes(Number(res.headers.CSeq));
}

const isDhResponse = (msg: Buffer) => msg.length > 9 && msg.subarray(0, 5).toString() === 'HTTP/';

/**
 * A UDP socket that speaks DH-HTTP with several peers. Incoming datagrams are
 * matched to pending requests by source address; anything else (PTCP, STUN) goes
 * to `onOther`, so the same local port can carry the handshake and the tunnel.
 */
export class DhSocket {
  readonly sock = dgram.createSocket('udp4');
  private cseq = 0;
  private waiters: { from: Endpoint; cseqs: number[] | null; resolve: (r: DhResponse) => void }[] = [];
  /** Responses that arrived before anyone asked (the cloud answers some requests late). */
  private early: { from: Endpoint; res: DhResponse }[] = [];
  onOther: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | null = null;
  bytesIn = 0;
  bytesOut = 0;
  private closed = false;

  constructor(private log?: Logger) {
    this.sock.on('message', (msg, rinfo) => {
      this.bytesIn += msg.length + 28; // + IPv4/UDP headers: what a metered link bills
      if (isDhResponse(msg)) {
        let res: DhResponse;
        try {
          res = parseDhResponse(msg.toString('utf8'));
        } catch {
          return;
        }
        this.log?.(`<<< ${rinfo.address}:${rinfo.port} ${res.code} ${res.status} ${JSON.stringify(res.body)}`);
        const i = this.waiters.findIndex(w => sameEndpoint(w.from, rinfo) && matchesCseq(res, w.cseqs));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(res);
        else this.early.push({ from: { host: rinfo.address, port: rinfo.port }, res });
        return;
      }
      this.onOther?.(msg, rinfo);
    });
    this.sock.on('error', err => this.log?.(`udp error: ${err.message}`));
  }

  async bind(): Promise<number> {
    await new Promise<void>(resolve => this.sock.bind(0, resolve));
    return this.sock.address().port;
  }

  get localPort(): number {
    return this.sock.address().port;
  }

  send(to: Endpoint, data: Buffer): void {
    if (this.closed) return;
    this.bytesOut += data.length + 28;
    this.sock.send(data, to.port, to.host);
  }

  /** Sends a request without waiting; returns its CSeq (answer collected later with `read`). */
  request(to: Endpoint, path: string, body?: string): number {
    this.log?.(`>>> ${to.host}:${to.port} ${body === undefined ? 'DHGET' : 'DHPOST'} ${path}${body ? ' ' + body : ''}`);
    this.send(to, buildDhRequest(path, ++this.cseq, body));
    return this.cseq;
  }

  /** Waits for the next response from `from` (final or provisional), optionally for given CSeqs. */
  read(from: Endpoint, timeoutMs: number, cseqs: number[] | null = null): Promise<DhResponse> {
    const i = this.early.findIndex(e => e.from.host === from.host && e.from.port === from.port && matchesCseq(e.res, cseqs));
    if (i >= 0) return Promise.resolve(this.early.splice(i, 1)[0].res);
    return new Promise((resolve, reject) => {
      const waiter = {
        from,
        cseqs,
        resolve: (r: DhResponse) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error(`timeout waiting for ${from.host}:${from.port}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Waits for a final (>= 200) response, skipping provisional ones. */
  async readFinal(from: Endpoint, timeoutMs: number, cseqs: number[] | null = null): Promise<DhResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.read(from, Math.max(1, deadline - Date.now()), cseqs);
      if (res.code >= 200) return res;
    }
  }

  /** Request + final response, retried on timeout (UDP). Throws on >= 300. */
  async call(to: Endpoint, path: string, body?: string, { timeoutMs = 2500, tries = 3 } = {}): Promise<DhResponse> {
    let lastErr: unknown;
    const cseqs: number[] = [];
    for (let t = 0; t < tries; t++) {
      cseqs.push(this.request(to, path, body));
      try {
        const res = await this.readFinal(to, timeoutMs, cseqs);
        if (res.code >= 300) throw Object.assign(new Error(`${path}: ${res.code} ${res.status}`), { code: res.code });
        return res;
      } catch (err) {
        lastErr = err;
        if ((err as any)?.code) throw err;
      }
    }
    throw lastErr;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w.resolve = () => {};
    this.waiters = [];
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }
}

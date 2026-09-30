"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DhSocket = exports.EASY4IP = void 0;
exports.resolveEndpoint = resolveEndpoint;
exports.sameEndpoint = sameEndpoint;
exports.parseXmlFlat = parseXmlFlat;
exports.parseDhResponse = parseDhResponse;
exports.buildDhRequest = buildDhRequest;
// DH-HTTP: the HTTP-like request/response protocol the Easy4ip cloud speaks over UDP.
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_dgram_1 = __importDefault(require("node:dgram"));
const promises_1 = __importDefault(require("node:dns/promises"));
/** Client credentials shared by every Dahua client (recovered from SmartPSS Lite). */
exports.EASY4IP = {
    server: 'www.easy4ipcloud.com:8800',
    username: 'cba1b29e32cb17aa46b8ff9e73c7f40b',
    userkey: '996103384cdf19179e19243e959bbf8b',
};
async function resolveEndpoint(addr) {
    const i = addr.lastIndexOf(':');
    const host = addr.slice(0, i);
    const port = Number(addr.slice(i + 1));
    if (!host || !port)
        throw new Error(`bad address "${addr}"`);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
        return { host, port };
    const { address } = await promises_1.default.lookup(host, { family: 4 });
    return { host: address, port };
}
function sameEndpoint(a, rinfo) {
    return a.host === rinfo.address && a.port === rinfo.port;
}
/** Minimal flat XML reader: nested tags joined by "/", text nodes only. */
function parseXmlFlat(xml) {
    const out = {};
    const stack = [];
    const re = /<(\/?)([A-Za-z0-9_:.-]+)[^>]*?(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
        if (m[4] !== undefined) {
            const text = m[4].trim();
            if (text && stack.length)
                out[stack.join('/')] = text;
        }
        else if (m[1]) {
            stack.pop();
        }
        else if (!m[3]) {
            stack.push(m[2]);
        }
    }
    return out;
}
function parseDhResponse(raw) {
    const split = raw.indexOf('\r\n\r\n');
    const head = split >= 0 ? raw.slice(0, split) : raw;
    const bodyText = split >= 0 ? raw.slice(split + 4) : '';
    const [statusLine, ...lines] = head.split('\r\n');
    const m = /^\S+\s+(\d+)\s*(.*)$/.exec(statusLine);
    if (!m)
        throw new Error(`bad DH response: ${statusLine}`);
    const headers = {};
    for (const line of lines) {
        const i = line.indexOf(':');
        if (i > 0)
            headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { code: Number(m[1]), status: m[2], headers, body: parseXmlFlat(bodyText), raw };
}
function wsseHeader() {
    const nonce = node_crypto_1.default.randomInt(0, 2 ** 31);
    const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = node_crypto_1.default
        .createHash('sha1')
        .update(`${nonce}${created}DHP2P:${exports.EASY4IP.username}:${exports.EASY4IP.userkey}`)
        .digest('base64');
    return ('Authorization: WSSE profile="UsernameToken"\r\n' +
        `X-WSSE: UsernameToken Username="${exports.EASY4IP.username}", PasswordDigest="${digest}", Nonce="${nonce}", Created="${created}"\r\n`);
}
function buildDhRequest(path, cseq, body) {
    const method = body === undefined ? 'DHGET' : 'DHPOST';
    return Buffer.from(`${method} ${path} HTTP/1.1\r\nCSeq: ${cseq}\r\n${wsseHeader()}\r\n${body ?? ''}`);
}
/** Responses without a CSeq header (some relay agents omit it) match any request. */
function matchesCseq(res, cseqs) {
    if (!cseqs || res.headers.CSeq === undefined)
        return true;
    return cseqs.includes(Number(res.headers.CSeq));
}
const isDhResponse = (msg) => msg.length > 9 && msg.subarray(0, 5).toString() === 'HTTP/';
/**
 * A UDP socket that speaks DH-HTTP with several peers. Incoming datagrams are
 * matched to pending requests by source address; anything else (PTCP, STUN) goes
 * to `onOther`, so the same local port can carry the handshake and the tunnel.
 */
class DhSocket {
    log;
    sock = node_dgram_1.default.createSocket('udp4');
    cseq = 0;
    waiters = [];
    /** Responses that arrived before anyone asked (the cloud answers some requests late). */
    early = [];
    onOther = null;
    bytesIn = 0;
    bytesOut = 0;
    closed = false;
    constructor(log) {
        this.log = log;
        this.sock.on('message', (msg, rinfo) => {
            this.bytesIn += msg.length + 28; // + IPv4/UDP headers: what a metered link bills
            if (isDhResponse(msg)) {
                let res;
                try {
                    res = parseDhResponse(msg.toString('utf8'));
                }
                catch {
                    return;
                }
                this.log?.(`<<< ${rinfo.address}:${rinfo.port} ${res.code} ${res.status} ${JSON.stringify(res.body)}`);
                const i = this.waiters.findIndex(w => sameEndpoint(w.from, rinfo) && matchesCseq(res, w.cseqs));
                if (i >= 0)
                    this.waiters.splice(i, 1)[0].resolve(res);
                else
                    this.early.push({ from: { host: rinfo.address, port: rinfo.port }, res });
                return;
            }
            this.onOther?.(msg, rinfo);
        });
        this.sock.on('error', err => this.log?.(`udp error: ${err.message}`));
    }
    async bind() {
        await new Promise(resolve => this.sock.bind(0, resolve));
        return this.sock.address().port;
    }
    get localPort() {
        return this.sock.address().port;
    }
    send(to, data) {
        if (this.closed)
            return;
        this.bytesOut += data.length + 28;
        this.sock.send(data, to.port, to.host);
    }
    /** Sends a request without waiting; returns its CSeq (answer collected later with `read`). */
    request(to, path, body) {
        this.log?.(`>>> ${to.host}:${to.port} ${body === undefined ? 'DHGET' : 'DHPOST'} ${path}${body ? ' ' + body : ''}`);
        this.send(to, buildDhRequest(path, ++this.cseq, body));
        return this.cseq;
    }
    /** Waits for the next response from `from` (final or provisional), optionally for given CSeqs. */
    read(from, timeoutMs, cseqs = null) {
        const i = this.early.findIndex(e => e.from.host === from.host && e.from.port === from.port && matchesCseq(e.res, cseqs));
        if (i >= 0)
            return Promise.resolve(this.early.splice(i, 1)[0].res);
        return new Promise((resolve, reject) => {
            const waiter = {
                from,
                cseqs,
                resolve: (r) => {
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
    async readFinal(from, timeoutMs, cseqs = null) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const res = await this.read(from, Math.max(1, deadline - Date.now()), cseqs);
            if (res.code >= 200)
                return res;
        }
    }
    /** Request + final response, retried on timeout (UDP). Throws on >= 300. */
    async call(to, path, body, { timeoutMs = 2500, tries = 3 } = {}) {
        let lastErr;
        const cseqs = [];
        for (let t = 0; t < tries; t++) {
            cseqs.push(this.request(to, path, body));
            try {
                const res = await this.readFinal(to, timeoutMs, cseqs);
                if (res.code >= 300)
                    throw Object.assign(new Error(`${path}: ${res.code} ${res.status}`), { code: res.code });
                return res;
            }
            catch (err) {
                lastErr = err;
                if (err?.code)
                    throw err;
            }
        }
        throw lastErr;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const w of this.waiters)
            w.resolve = () => { };
        this.waiters = [];
        try {
            this.sock.close();
        }
        catch {
            /* already closed */
        }
    }
}
exports.DhSocket = DhSocket;
//# sourceMappingURL=dhhttp.js.map
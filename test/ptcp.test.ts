import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bodies, Body, decodePacket, encodePacket, parseBody, PtcpSession, seqAfter } from '../src/ptcp.js';

/** Two sessions joined by a link that loses, duplicates and reorders datagrams. */
function lossyPair(o: { loss: number; dup: number; maxDelayMs: number; seed?: number }) {
  let seed = o.seed ?? 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deliver = (to: () => PtcpSession) => (d: Buffer) => {
    if (rand() < o.loss) return;
    const copies = rand() < o.dup ? 2 : 1;
    for (let i = 0; i < copies; i++) setTimeout(() => to().input(Buffer.from(d)), Math.floor(rand() * o.maxDelayMs));
  };
  const opts = { rtoMs: 40, ackDelayMs: 5, heartbeatMs: 60_000 };
  const a: PtcpSession = new PtcpSession({ ...opts, transmit: deliver(() => b) });
  const b: PtcpSession = new PtcpSession({ ...opts, transmit: deliver(() => a) });
  return { a, b };
}

function collect(s: PtcpSession, realm: number): Buffer[] {
  const out: Buffer[] = [];
  s.on('body', (x: Body) => {
    if (x.type === 'data' && x.realm === realm) out.push(Buffer.from(x.data));
  });
  return out;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('packet header round-trips', () => {
  const p = { sent: 0xfffffff0, recv: 12, pid: 0x0000ffe7, lmid: 0x0aa0a316, rmid: 7, body: bodies.heartbeat() };
  const d = decodePacket(encodePacket(p))!;
  assert.deepEqual({ ...d, body: Buffer.from(d.body) }, p);
  assert.equal(decodePacket(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')), null);
});

test('bodies parse back', () => {
  assert.deepEqual(parseBody(bodies.sync()), { type: 'sync' });
  assert.deepEqual(parseBody(bodies.heartbeat()), { type: 'heartbeat' });
  const d = parseBody(bodies.data(0xabcd, Buffer.from('hello')));
  assert.equal(d.type, 'data');
  assert.equal(d.type === 'data' && d.data.toString(), 'hello');
  const b = parseBody(bodies.bind(5, 554));
  assert.deepEqual(b, { type: 'bind', realm: 5, port: 554 });
  const s = parseBody(bodies.status(9, 'CONN'));
  assert.deepEqual(s, { type: 'status', realm: 9, status: 'CONN' });
});

test('sequence comparison wraps around', () => {
  assert.ok(seqAfter(5, 0xfffffff0));
  assert.ok(!seqAfter(0xfffffff0, 5));
  assert.ok(!seqAfter(7, 7));
});

test('in-order bytes, duplicates ignored, gaps parked until filled', () => {
  const sent: Buffer[] = [];
  const s = new PtcpSession({ transmit: d => sent.push(d), ackDelayMs: 1, heartbeatMs: 60_000 });
  const got = collect(s, 1);
  const pkt = (offset: number, text: string) =>
    encodePacket({ sent: offset, recv: 0, pid: 0, lmid: 1, rmid: 0, body: bodies.data(1, Buffer.from(text)) });
  const len = (text: string) => 12 + text.length;

  s.input(pkt(0, 'aa'));
  s.input(pkt(0, 'aa')); // duplicate
  s.input(pkt(len('aa') + len('bb'), 'cc')); // arrives before 'bb'
  assert.deepEqual(got.map(String), ['aa']);
  assert.equal(s.received, len('aa'));
  s.input(pkt(len('aa'), 'bb'));
  assert.deepEqual(got.map(String), ['aa', 'bb', 'cc']);
  assert.equal(s.received, len('aa') + len('bb') + len('cc'));
  assert.equal(s.stats.duplicatesIn, 1);
  assert.equal(s.stats.gapsFilled, 1);
  s.close();
});

test('the ACK never runs ahead of contiguous bytes', () => {
  const acks: number[] = [];
  const s = new PtcpSession({ transmit: d => acks.push(decodePacket(d)!.recv), ackDelayMs: 1, heartbeatMs: 60_000 });
  s.input(encodePacket({ sent: 100, recv: 0, pid: 0, lmid: 1, rmid: 0, body: bodies.heartbeat() }));
  assert.deepEqual(acks, [0]); // immediate ACK of where we are, not of offset 112
  s.close();
});

test('offsets survive 32-bit wrap-around', () => {
  const s = new PtcpSession({ transmit: () => {}, heartbeatMs: 60_000 });
  const got = collect(s, 2);
  (s as any).rcvNext = 0xfffffff8;
  const body = bodies.data(2, Buffer.from('wrap'));
  s.input(encodePacket({ sent: 0xfffffff8, recv: 0, pid: 0, lmid: 1, rmid: 0, body }));
  s.input(encodePacket({ sent: (0xfffffff8 + body.length) >>> 0, recv: 0, pid: 0, lmid: 2, rmid: 0, body }));
  assert.equal(got.length, 2);
  assert.equal(s.received, (0xfffffff8 + 2 * body.length) >>> 0);
  s.close();
});

test('a stream crosses a lossy, duplicating, reordering link intact', async () => {
  const { a, b } = lossyPair({ loss: 0.05, dup: 0.05, maxDelayMs: 25, seed: 42 });
  const got = collect(b, 7);
  const payload = crypto.randomBytes(200_000);
  a.sendData(7, payload);
  await waitFor(() => got.reduce((n, x) => n + x.length, 0) >= payload.length, 20_000);
  assert.ok(Buffer.concat(got).equals(payload));
  assert.ok(a.stats.retransmitsOut > 0, 'loss must have forced retransmissions');
  assert.ok(b.stats.duplicatesIn > 0);
  await waitFor(() => a.unacked === 0, 5000);
  a.close();
  b.close();
});

test('closes when the peer stops acknowledging', async () => {
  const s = new PtcpSession({ transmit: () => {}, rtoMs: 10, maxRetries: 3, heartbeatMs: 60_000 });
  const reason = new Promise(r => s.once('closed', r));
  s.send(bodies.heartbeat());
  assert.equal(await reason, 'peer stopped acknowledging');
});

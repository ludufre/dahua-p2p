import test from 'node:test';
import assert from 'node:assert/strict';
import { Depacketizer, parseSdpVideo, VideoFrame } from '../src/rtsp.js';

// SDP as served by the Intelbras iM4-C sub stream (trimmed)
const SDP = [
  'v=0',
  'o=- 2251938210 2251938210 IN IP4 0.0.0.0',
  's=Media Server',
  'm=video 0 RTP/AVP 96',
  'a=control:trackID=0',
  'a=framerate:15.000000',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1;profile-level-id=4D401E;sprop-parameter-sets=Z01AHpWoKA9puAgICBA=,aO48gA==',
  'a=recvonly',
  'm=audio 0 RTP/AVP 97',
  'a=control:trackID=1',
  'a=rtpmap:97 MPEG4-GENERIC/16000',
].join('\r\n');

const rtp = (seq: number, ts: number, marker: boolean, payload: Buffer, pt = 96) => {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(ts, 4);
  return Buffer.concat([h, payload]);
};

test('SDP: picks the video track, codec and parameter sets', () => {
  const t = parseSdpVideo(SDP)!;
  assert.equal(t.codec, 'h264');
  assert.equal(t.payloadType, 96);
  assert.equal(t.control, 'trackID=0');
  assert.equal(t.paramSets.length, 2);
  assert.equal(t.paramSets[0][0] & 0x1f, 7); // SPS
  assert.equal(t.paramSets[1][0] & 0x1f, 8); // PPS
});

test('H.264: FU-A keyframe gets SPS/PPS prepended; single NAL P-frame passes through', () => {
  const track = parseSdpVideo(SDP)!;
  const frames: VideoFrame[] = [];
  const d = new Depacketizer(track, f => frames.push(f));
  const idr = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3000, 7)]);
  // FU-A split in 3
  const fuInd = (idr[0] & 0xe0) | 28;
  const parts = [idr.subarray(1, 1001), idr.subarray(1001, 2001), idr.subarray(2001)];
  parts.forEach((p, i) => {
    const fuh = (i === 0 ? 0x80 : 0) | (i === parts.length - 1 ? 0x40 : 0) | (idr[0] & 0x1f);
    d.push(rtp(10 + i, 9000, i === parts.length - 1, Buffer.concat([Buffer.from([fuInd, fuh]), p])));
  });
  d.push(rtp(13, 15000, true, Buffer.from([0x41, 1, 2, 3])));
  assert.equal(frames.length, 2);
  assert.ok(frames[0].keyframe);
  const start = Buffer.from([0, 0, 0, 1]);
  const expected = Buffer.concat([start, track.paramSets[0], start, track.paramSets[1], start, idr]);
  assert.ok(frames[0].data.equals(expected));
  assert.ok(!frames[1].keyframe);
  assert.ok(frames[1].data.equals(Buffer.from([0, 0, 0, 1, 0x41, 1, 2, 3])));
});

test('H.264: STAP-A with SPS+PPS+IDR is a keyframe without duplicated parameter sets', () => {
  const track = parseSdpVideo(SDP)!;
  const frames: VideoFrame[] = [];
  const d = new Depacketizer(track, f => frames.push(f));
  const nals = [track.paramSets[0], track.paramSets[1], Buffer.from([0x65, 9, 9])];
  const stap = Buffer.concat([Buffer.from([24]), ...nals.flatMap(n => [Buffer.from([n.length >> 8, n.length & 0xff]), n])]);
  d.push(rtp(1, 100, true, stap));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].keyframe);
  assert.equal(frames[0].data.length, nals.reduce((s, n) => s + 4 + n.length, 0));
});

test('a lost fragment drops the frame instead of emitting a corrupt one', () => {
  const track = parseSdpVideo(SDP)!;
  const frames: VideoFrame[] = [];
  const d = new Depacketizer(track, f => frames.push(f));
  d.push(rtp(1, 100, false, Buffer.from([0x7c, 0x85, 1, 1])));
  // seq 2 lost
  d.push(rtp(3, 100, true, Buffer.from([0x7c, 0x45, 3, 3])));
  d.push(rtp(4, 200, true, Buffer.from([0x41, 5])));
  assert.equal(frames.length, 1);
  assert.ok(!frames[0].keyframe);
});

test('H.265: FU reassembly and IDR detection', () => {
  const sdp = SDP.replace('H264/90000', 'H265/90000').replace(
    /a=fmtp:96 .*/,
    'a=fmtp:96 sprop-vps=QAEMAf//AWAAAAMAkAAAAwAAAwBdlZgJ;sprop-sps=QgEBAWAAAAMAkAAAAwAAAwBdoAKAgC0WWVmkkyuAQAAA+kAAF3AC;sprop-pps=RAHBcrRiQA==',
  );
  const track = parseSdpVideo(sdp)!;
  assert.equal(track.codec, 'h265');
  assert.equal(track.paramSets.length, 3);
  const frames: VideoFrame[] = [];
  const d = new Depacketizer(track, f => frames.push(f));
  // IDR_W_RADL = 19 → NAL header 0x26 0x01; FU header type 49 → 0x62 0x01
  d.push(rtp(1, 100, false, Buffer.from([0x62, 0x01, 0x80 | 19, 0xaa])));
  d.push(rtp(2, 100, true, Buffer.from([0x62, 0x01, 0x40 | 19, 0xbb])));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].keyframe);
  assert.ok(frames[0].data.includes(Buffer.from([0x26, 0x01, 0xaa, 0xbb])));
});

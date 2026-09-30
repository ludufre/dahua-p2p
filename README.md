<p align="center"><br>
<img src="https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/22/47/83/224783f5-ac3e-0dac-f866-6a21b4118b89/AppIcon-0-0-1x_U007ephone-0-11-0-sRGB-85-220.png/128x128bb.jpg" width="128" height="128" />
</p>

### dahua-p2p

Unofficial TypeScript P2P tunnel and RTSP client for Dahua and Intelbras (Mibo Smart) cameras — usable as a **library** or **CLI**

> ⚠️ **Disclaimer:** This project is **not affiliated with, endorsed by, or associated with Zhejiang Dahua Technology Co., Ltd. or Intelbras S.A.** in any way. Dahua, Easy4ip, DMSS, Intelbras and Mibo are trademarks of their respective owners. Use of these names and logos is solely for identification purposes. This is an independent, community-driven project developed through reverse engineering of the P2P protocol.
>
> This project is intended for **personal and research use only**. It must not be used for commercial purposes, sold, or otherwise financially exploited.
>
> Users connect only to **their own devices**, using their own device serial and credentials. No credentials are stored or transmitted by this library beyond what is necessary to reach the device on behalf of the user — no impersonation of Dahua, Intelbras or their services is intended.
>
> **Note to Dahua and Intelbras employees:** If this repository raises any concerns regarding intellectual property, terms of service, or any other matter, please reach out via [GitHub Issues](https://github.com/ludufre/dahua-p2p/issues) or directly to [@ludufre](https://github.com/ludufre). I will promptly take down or modify the repository upon request — no legal action necessary.

[![Maintenance](https://img.shields.io/maintenance/yes/2026?style=flat-square)](https://github.com/ludufre/dahua-p2p)
[![NPM License](https://img.shields.io/npm/l/dahua-p2p?style=flat-square)](https://www.npmjs.com/package/dahua-p2p)
[![NPM Downloads](https://img.shields.io/npm/dw/dahua-p2p?style=flat-square)](https://www.npmjs.com/package/dahua-p2p)
[![NPM Version](https://img.shields.io/npm/v/dahua-p2p?style=flat-square)](https://www.npmjs.com/package/dahua-p2p)

## Maintainers

| Maintainer | GitHub | Social | LinkedIn |
| ---------------------- | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| Luan Freitas (ludufre) | [ludufre](https://github.com/ludufre) | [@ludufre](https://x.com/ludufre) | [Luan Freitas](https://www.linkedin.com/in/luan-freitas-14341687/) |

## Overview

Reach Dahua and Intelbras (Mibo Smart) cameras through the **Easy4ip cloud relay**, with no app, VPN or port forwarding. It works behind 4G and carrier-grade NAT.

The protocol comes from [khoanguyen-3fc/dh-p2p](https://github.com/khoanguyen-3fc/dh-p2p) (handshake and crypto) and [blackjid/dahua-p2p](https://github.com/blackjid/dahua-p2p) (session behaviour). It adds a **reliable PTCP layer**. The relay loses and reorders datagrams, so the receiver only acknowledges contiguous bytes, parks early datagrams until the gap is filled, and drops duplicates. The device then retransmits whatever is missing. The PoC implementations above sum every received body into the ACK, and that stalls or corrupts the stream.

- Pure Node.js and TypeScript, with no native dependencies.
- **Tunnel:** any device port (RTSP 554, HTTP 80, 37777) is carried as a stream, or exposed on a local TCP port.
- **RTSP client:** Digest auth, video track only, and H.264/H.265 RTP depacketized into Annex B access units.
- **Photo mode:** open RTSP, take the first keyframe, TEARDOWN. The tunnel is reused between photos.
- **Byte accounting:** traffic is counted on the wire, IPv4/UDP headers included, which is what a metered link bills.

Only the **device serial** and the **device user/password** are needed. The RTSP login needs the credentials; the tunnel itself does not.

## Install

```bash
npm install dahua-p2p      # library
npx dahua-p2p --help       # CLI
```

## CLI

```bash
# Expose the camera's RTSP on 127.0.0.1:1554 (then: ffplay rtsp://admin:pass@127.0.0.1:1554/cam/realmonitor?channel=1&subtype=1)
dahua-p2p tunnel <SERIAL> -l 1554

# 10 photos, one every 5 s, each with its wire cost; the first one saved as JPEG (needs ffmpeg)
dahua-p2p snapshot <SERIAL> -u admin -p <pass> -n 10 -i 5 -o photo.jpg

# Stability test: live video for 10 minutes, fails on a 5 s stall
dahua-p2p soak <SERIAL> -u admin -p <pass> -m 10
```

## Library

```ts
import { openTunnel, openRtsp, captureKeyframe } from 'dahua-p2p';

const tunnel = await openTunnel({ serial: '<SERIAL>' });

// Live frames
const rtsp = await openRtsp(tunnel, { user: 'admin', pass: '…', channel: 1, subtype: 1 });
rtsp.on('frame', f => console.log(f.codec, f.keyframe, f.data.length));

// One photo (the tunnel serializes realms: it waits for any other RTSP session to end)
const { frame, bytes } = await captureKeyframe(tunnel, { user: 'admin', pass: '…' });

console.log(tunnel.stats); // udpBytesIn/Out, PTCP counters
tunnel.close();
```

## Measured (Intelbras iM4-C, sub stream 640×480 H.264, relay, 2026-09-30)

| | |
|---|---|
| Handshake | ~0.5 s (p90 0.55 s) |
| Live, 10 × 30 s | 10/10 intact streams. Each session saw 12–143 datagrams arrive out of order, and all of them were reordered |
| Photo | ~0.8 s, 52–111 KB on the wire (keyframe 32–68 KB, plus video in flight until TEARDOWN) |
| Idle tunnel | a heartbeat every 5 s, under 2 MB/month |

## One relay session at a time

A device accepts **one relay session at a time**. It also keeps a closed session for **about 15–20 s**, until its heartbeats time out. Neither a realm `DISC` nor closing the socket frees it sooner. A second tunnel opened in that window, or while another client such as the vendor app holds the relay, never gets the agent's "device joined" confirmation.

`openTunnel` handles this. It waits 3 s for that confirmation (it normally arrives in about 100 ms), then retries every 4 s for up to `busyRetryMs` (35 s by default). If the device is still busy after that, it throws `DeviceBusy`. A tunnel reopened back-to-back is measured at ~22 s; a fresh one takes ~0.5 s.

**Keep one tunnel per device** and reuse it (RTSP sessions and photos come and go inside it). Close it only when you are really done, and remember that while it is open the vendor app may not get the relay.

## Limitations

- Relay mode only. Direct P2P (inverted STUN) is not implemented, because it does not work behind CGNAT anyway.
- Devices that require channel authentication (HTTP 403 on `p2p-channel`) throw `DeviceAuthRequired`.
- The tunnel runs one realm (TCP connection) at a time. Devices can multiplex several, but serialising keeps RTSP negotiation reliable.

## Tests

```bash
npm test   # PTCP over a lossy/duplicating/reordering link, wrap-around, RTP depacketization
```

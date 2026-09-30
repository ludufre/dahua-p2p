// Easy4ip handshake: locate the device by serial and get a PTCP path to it.
//
// Relay mode (what works behind carrier-grade NAT / 4G):
//   main   /probe/p2psrv, /online/p2psrv/{SN} → P2P server, /online/relay → relay
//   p2psrv /probe/device/{SN}, /info/device/{SN}
//   main   /device/{SN}/p2p-channel          (answered later, with the device's addresses)
//   relay  /relay/agent → token + agent
//   agent  /relay/start/{token}
//   main   /device/{SN}/relay-channel        (device is told to join the agent)
//   agent  PTCP SYNC ⇄ device SYNC           → the agent now forwards our PTCP to the device
import crypto from 'node:crypto';
import { DhSocket, EASY4IP, Endpoint, Logger, resolveEndpoint } from './dhhttp.js';
import { decryptDeviceInfo, DeviceInfo } from './crypto.js';
import { bodies, PtcpSession } from './ptcp.js';

export interface HandshakeResult {
  peer: Endpoint;
  session: PtcpSession;
  info: DeviceInfo | null;
  /** Device addresses as reported by the cloud (for diagnostics / direct mode). */
  device: { localAddr?: string; pubAddr?: string };
  timings: Record<string, number>;
}

export class DeviceAuthRequired extends Error {
  constructor() {
    super('device requires channel authentication (not supported yet)');
  }
}

/**
 * The relay agent never confirmed that the device joined. Devices take one relay
 * session at a time and keep a closed one for ~15–20 s (until its heartbeats time
 * out), so this is what a new tunnel sees right after another one — or while
 * another client (e.g. the vendor app) holds the relay.
 */
export class DeviceBusy extends Error {
  constructor() {
    super('device did not join the relay (busy with another relay session?)');
  }
}

export async function relayHandshake(
  sock: DhSocket,
  serial: string,
  opts: { log?: Logger; timeoutMs?: number; joinTimeoutMs?: number; cloud?: string } = {},
): Promise<HandshakeResult> {
  const log = opts.log;
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Date.now() - t0);

  const main = await resolveEndpoint(opts.cloud || EASY4IP.server);
  await sock.call(main, '/probe/p2psrv');
  const online = await sock.call(main, `/online/p2psrv/${serial}`);
  const us = online.body['body/US'];
  if (!us) throw new Error(`device ${serial} is not online in the cloud`);
  const relayRes = await sock.call(main, '/online/relay');
  const relayAddr = relayRes.body['body/Address'];
  if (!relayAddr) throw new Error('cloud returned no relay server');
  mark('cloud');

  const p2psrv = await resolveEndpoint(us);
  await sock.call(p2psrv, `/probe/device/${serial}`);
  let info: DeviceInfo | null = null;
  try {
    const res = await sock.call(p2psrv, `/info/device/${serial}`, undefined, { tries: 1, timeoutMs: 2000 });
    info = decryptDeviceInfo(res.body['body/Info']);
  } catch (err) {
    log?.(`device info unavailable: ${(err as Error).message}`);
  }
  mark('p2psrv');

  const cid = crypto.randomBytes(8);
  const channelCseq = sock.request(
    main,
    `/device/${serial}/p2p-channel`,
    `<body><Identify>${[...cid].map(b => b.toString(16)).join(' ')}</Identify><IpEncrpt>true</IpEncrpt>` +
      `<LocalAddr>127.0.0.1:${sock.localPort}</LocalAddr><version>5.0.0</version></body>`,
  );

  const relay = await resolveEndpoint(relayAddr);
  const agentRes = await sock.call(relay, '/relay/agent');
  const token = agentRes.body['body/Token'];
  const agentAddr = agentRes.body['body/Agent'];
  if (!token || !agentAddr) throw new Error('relay returned no agent');
  const agent = await resolveEndpoint(agentAddr);
  await sock.call(agent, `/relay/start/${token}`, '<body><Client>:0</Client></body>');
  mark('agent');

  const channel = await sock.readFinal(main, opts.timeoutMs ?? 8000, [channelCseq]);
  if (channel.code === 403) throw new DeviceAuthRequired();
  if (channel.code >= 300) throw new Error(`p2p-channel: ${channel.code} ${channel.status}`);
  const device = { localAddr: channel.body['body/LocalAddr'], pubAddr: channel.body['body/PubAddr'] };
  mark('channel');

  sock.request(main, `/device/${serial}/relay-channel`, `<body><agentAddr>${agentAddr}</agentAddr></body>`);
  // The agent confirms the device joined within ~100 ms, or never (device busy)
  await sock.readFinal(agent, opts.joinTimeoutMs ?? 3000).catch(() => {
    throw new DeviceBusy();
  });
  mark('relay-channel');

  const session = new PtcpSession({ transmit: d => sock.send(agent, d), log });
  sock.onOther = (msg, rinfo) => {
    if (rinfo.address === agent.host && rinfo.port === agent.port) session.input(msg);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('body', onBody);
      session.close('sync timeout');
      reject(new Error('device did not answer PTCP SYNC through the relay'));
    }, opts.timeoutMs ?? 8000);
    const onBody = (b: { type: string }) => {
      if (b.type !== 'sync') return;
      clearTimeout(timer);
      session.off('body', onBody);
      resolve();
    };
    session.on('body', onBody);
    session.send(bodies.sync());
  });
  mark('sync');
  log?.(`relay handshake done in ${timings.sync} ms via agent ${agentAddr}`);

  return { peer: agent, session, info, device, timings };
}

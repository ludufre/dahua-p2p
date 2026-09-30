// Easy4ip crypto (recovered by the dh-p2p project, khoanguyen-3fc/dh-p2p).
import crypto from 'node:crypto';

/** Fixed key/IV for the <Info> payload of /info/device/{SN} — shared by every device. */
const INFO_KEY = Buffer.from('kRjmsUB&ezmdGLL67H#$ojw@XflcaIaf');
const INFO_IV = Buffer.from('MydvJw*Iw1w&i^kk');
/** IV of the per-session (device password derived) encryption. */
const SESSION_IV = Buffer.from('2z52*lk9o6HRyJrf');

export interface DeviceInfo {
  httpport?: number;
  privport?: number;
  rtspport?: number;
  tlsprivport?: number;
  /** Realm salt of the device password hash. */
  randsalt?: string;
}

/** Decrypts <Info>; null when absent or not decryptable (rebranded clouds may use another key). */
export function decryptDeviceInfo(info: string | undefined): DeviceInfo | null {
  if (!info) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-ofb', INFO_KEY, INFO_IV);
    const plain = Buffer.concat([d.update(Buffer.from(info, 'base64')), d.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

/** Device key: uppercase MD5 of "user:Login to {randsalt}:pass" (ASCII hex, used as bytes). */
export function deviceKey(user: string, pass: string, randsalt = ''): Buffer {
  return Buffer.from(crypto.createHash('md5').update(`${user}:Login to ${randsalt}:${pass}`).digest('hex').toUpperCase());
}

function sessionCipher(key: Buffer, nonce: number) {
  const dk = crypto.pbkdf2Sync(key, Buffer.from(String(nonce)), 20000, 32, 'sha256');
  return crypto.createCipheriv('aes-256-ofb', dk, SESSION_IV);
}

/** Encrypts a value (e.g. LocalAddr) for an authenticated channel request. */
export function sessionEncrypt(key: Buffer, nonce: number, data: string): string {
  const c = sessionCipher(key, nonce);
  return Buffer.concat([c.update(data, 'utf8'), c.final()]).toString('base64');
}

/** OFB is symmetric: decrypting is encrypting again. */
export function sessionDecrypt(key: Buffer, nonce: number, data: string): string {
  const c = sessionCipher(key, nonce);
  return Buffer.concat([c.update(Buffer.from(data, 'base64')), c.final()]).toString('utf8');
}

/** DevAuth of an authenticated channel request. */
export function devAuth(key: Buffer, nonce: number, createDate: number, payload = ''): string {
  return crypto.createHmac('sha256', key).update(`${nonce}${createDate}${payload}`).digest('base64');
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptDeviceInfo = decryptDeviceInfo;
exports.deviceKey = deviceKey;
exports.sessionEncrypt = sessionEncrypt;
exports.sessionDecrypt = sessionDecrypt;
exports.devAuth = devAuth;
// Easy4ip crypto (recovered by the dh-p2p project, khoanguyen-3fc/dh-p2p).
const node_crypto_1 = __importDefault(require("node:crypto"));
/** Fixed key/IV for the <Info> payload of /info/device/{SN} — shared by every device. */
const INFO_KEY = Buffer.from('kRjmsUB&ezmdGLL67H#$ojw@XflcaIaf');
const INFO_IV = Buffer.from('MydvJw*Iw1w&i^kk');
/** IV of the per-session (device password derived) encryption. */
const SESSION_IV = Buffer.from('2z52*lk9o6HRyJrf');
/** Decrypts <Info>; null when absent or not decryptable (rebranded clouds may use another key). */
function decryptDeviceInfo(info) {
    if (!info)
        return null;
    try {
        const d = node_crypto_1.default.createDecipheriv('aes-256-ofb', INFO_KEY, INFO_IV);
        const plain = Buffer.concat([d.update(Buffer.from(info, 'base64')), d.final()]).toString('utf8');
        return JSON.parse(plain);
    }
    catch {
        return null;
    }
}
/** Device key: uppercase MD5 of "user:Login to {randsalt}:pass" (ASCII hex, used as bytes). */
function deviceKey(user, pass, randsalt = '') {
    return Buffer.from(node_crypto_1.default.createHash('md5').update(`${user}:Login to ${randsalt}:${pass}`).digest('hex').toUpperCase());
}
function sessionCipher(key, nonce) {
    const dk = node_crypto_1.default.pbkdf2Sync(key, Buffer.from(String(nonce)), 20000, 32, 'sha256');
    return node_crypto_1.default.createCipheriv('aes-256-ofb', dk, SESSION_IV);
}
/** Encrypts a value (e.g. LocalAddr) for an authenticated channel request. */
function sessionEncrypt(key, nonce, data) {
    const c = sessionCipher(key, nonce);
    return Buffer.concat([c.update(data, 'utf8'), c.final()]).toString('base64');
}
/** OFB is symmetric: decrypting is encrypting again. */
function sessionDecrypt(key, nonce, data) {
    const c = sessionCipher(key, nonce);
    return Buffer.concat([c.update(Buffer.from(data, 'base64')), c.final()]).toString('utf8');
}
/** DevAuth of an authenticated channel request. */
function devAuth(key, nonce, createDate, payload = '') {
    return node_crypto_1.default.createHmac('sha256', key).update(`${nonce}${createDate}${payload}`).digest('base64');
}
//# sourceMappingURL=crypto.js.map
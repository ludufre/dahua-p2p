export interface DeviceInfo {
    httpport?: number;
    privport?: number;
    rtspport?: number;
    tlsprivport?: number;
    /** Realm salt of the device password hash. */
    randsalt?: string;
}
/** Decrypts <Info>; null when absent or not decryptable (rebranded clouds may use another key). */
export declare function decryptDeviceInfo(info: string | undefined): DeviceInfo | null;
/** Device key: uppercase MD5 of "user:Login to {randsalt}:pass" (ASCII hex, used as bytes). */
export declare function deviceKey(user: string, pass: string, randsalt?: string): Buffer;
/** Encrypts a value (e.g. LocalAddr) for an authenticated channel request. */
export declare function sessionEncrypt(key: Buffer, nonce: number, data: string): string;
/** OFB is symmetric: decrypting is encrypting again. */
export declare function sessionDecrypt(key: Buffer, nonce: number, data: string): string;
/** DevAuth of an authenticated channel request. */
export declare function devAuth(key: Buffer, nonce: number, createDate: number, payload?: string): string;

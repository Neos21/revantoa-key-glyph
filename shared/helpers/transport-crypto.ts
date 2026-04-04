import { decodeText, encodeText, fromBase64, toArrayBuffer, toBase64 } from './codec';

import type { OpaqueEnvelope } from '../types/crypto';

/** ECDH で使用する楕円曲線パラメータ */
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** 送信時に使用するメタ情報 */
type SealMeta = {
  /** Session ID */
  s: string;
  /** 連番 */
  q: number;
  /** API パス */
  p: string;
  /** HTTP メソッド */
  m: string;
  /** 送信時刻 */
  t?: number;
};

/** 受信時に使用するメタ情報 */
type OpenMeta = {
  /** API パス */
  p: string;
  /** HTTP メソッド */
  m: string;
  /** 許容時刻差 (`maxSkewMs`) の上限 */
  s: number;
  /** 現在時刻 */
  n?: number;
};

/**
 * 追加認証データを生成する
 * 
 * @param envelope 送受信 Envelope
 * @param meta 送信メタ情報
 * @return AES-GCM の追加認証データ
 */
const buildAad = (envelope: Pick<OpaqueEnvelope, 's' | 'q' | 't'>, meta: Pick<SealMeta, 'p' | 'm'>): ArrayBuffer => toArrayBuffer(encodeText(`${envelope.s}|${meta.m}|${meta.p}|${envelope.q}|${envelope.t}`));

/**
 * ECDH 鍵ペアを生成する
 * 
 * @return 生成した鍵ペア
 */
export const generateEcdhKeyPair = async (): Promise<CryptoKeyPair> => crypto.subtle.generateKey(P256, true, ['deriveBits']);

/**
 * ECDH 公開鍵を Base64 文字列へ変換する
 * 
 * @param publicKey 変換対象の公開鍵
 * @return Base64 化した公開鍵
 */
export const exportEcdhPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return toBase64(raw);
};

/**
 * Base64 文字列から ECDH 公開鍵を復元する
 * 
 * @param publicKeyBase64 Base64 形式の公開鍵
 * @return 復元した公開鍵
 */
export const importEcdhPublicKey = async (publicKeyBase64: string): Promise<CryptoKey> => crypto.subtle.importKey('raw', toArrayBuffer(fromBase64(publicKeyBase64)), P256, true, []);

/**
 * 共有秘密ビット列を導出する
 * 
 * @param privateKey 自身の秘密鍵
 * @param remotePublicKey 相手の公開鍵
 * @return 共有秘密のビット列
 */
export const deriveSharedBits = async (privateKey: CryptoKey, remotePublicKey: CryptoKey): Promise<ArrayBuffer> => crypto.subtle.deriveBits({ name: 'ECDH', public: remotePublicKey }, privateKey, 256);

/**
 * 共有秘密から AES 鍵を導出する
 * 
 * @param sharedBits ECDH で得た共有秘密
 * @param salt HKDF で使用する Salt
 * @param info HKDF で使用する Info
 * @return 導出した AES 鍵
 */
const deriveAesKey = async (sharedBits: ArrayBuffer, salt: Uint8Array, info: string): Promise<CryptoKey> => {
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(encodeText(info))
    },
    hkdfKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
};

/**
 * 通信チャネルごとの鍵を導出する
 * 
 * @param sharedBits ECDH で得た共有秘密
 * @param salt HKDF で使用する Salt
 * @return 位置チャネル鍵 `i` と文字列チャネル鍵 `m`
 */
export const deriveTransportKeys = async (sharedBits: ArrayBuffer, salt: Uint8Array): Promise<{ i: CryptoKey; m: CryptoKey; }> => {
  const [i, m] = await Promise.all([
    deriveAesKey(sharedBits, salt, 'kg-i'),
    deriveAesKey(sharedBits, salt, 'kg-m')
  ]);
  return { i, m };
};

/**
 * Payload を暗号化して Envelope を生成する
 * 
 * @param payload 暗号化対象の Payload
 * @param key 暗号化に使用する鍵
 * @param meta 送信メタ情報
 * @return 暗号化済み Envelope
 */
export const sealEnvelope = async <T>(payload: T, key: CryptoKey, meta: SealMeta): Promise<OpaqueEnvelope> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope: OpaqueEnvelope = {
    s: meta.s,
    q: meta.q,
    t: meta.t ?? Date.now(),
    v: toBase64(iv),
    c: ''
  };
  const cipherText = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: buildAad(envelope, meta)
    },
    key,
    toArrayBuffer(encodeText(JSON.stringify(payload)))
  );
  envelope.c = toBase64(cipherText);
  return envelope;
};

/**
 * 暗号化 Envelope を復号して Payload を取り出す
 * 
 * @param envelope 復号対象の Envelope
 * @param key 復号に使用する鍵
 * @param meta 受信メタ情報
 * @return 復号した Payload
 */
export const openEnvelope = async <T>(envelope: OpaqueEnvelope, key: CryptoKey, meta: OpenMeta): Promise<T> => {
  const now = meta.n ?? Date.now();
  if(Math.abs(now - envelope.t) > meta.s) throw new Error('Stale Envelope');
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(fromBase64(envelope.v)),
      additionalData: buildAad(envelope, meta)
    },
    key,
    toArrayBuffer(fromBase64(envelope.c))
  );
  return JSON.parse(decodeText(plain)) as T;
};

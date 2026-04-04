/** UTF-8 エンコードに使用するエンコーダ */
const textEncoder = new TextEncoder();
/** UTF-8 デコードに使用するデコーダ */
const textDecoder = new TextDecoder();

/**
 * 文字列を UTF-8 の Uint8Array に変換する
 * 
 * @param text 変換元の文字列
 * @return UTF-8 バイト配列
 */
export const encodeText = (text: string): Uint8Array => textEncoder.encode(text);

/**
 * バイト列を UTF-8 文字列へ変換する
 * 
 * @param bytes 変換対象のバイト列
 * @return デコード後の文字列
 */
export const decodeText = (bytes: BufferSource): string => textDecoder.decode(bytes);

/**
 * Uint8Array から独立した ArrayBuffer を作成する
 * 
 * @param bytes 変換対象のバイト配列
 * @return 変換後の ArrayBuffer
 */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

/**
 * バイト列を Base64 文字列へ変換する
 * 
 * @param bytes 変換対象のバイト列
 * @return Base64 文字列
 */
export const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for(const value of view) binary += String.fromCharCode(value);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(view).toString('base64');
};

/**
 * Base64 文字列を Uint8Array へ変換する
 * 
 * @param base64 変換対象の Base64 文字列
 * @return デコード後のバイト配列
 */
export const fromBase64 = (base64: string): Uint8Array => {
  if(typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
};

/**
 * ランダムトークンを16進文字列で生成する
 * 
 * @param size 生成するバイト長
 * @return ランダムトークン文字列
 */
export const randomToken = (size = 16): string => {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
};

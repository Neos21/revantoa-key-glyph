import { Hono } from 'hono';

import { o } from '../shared/constants/opaque-api';
import { fromBase64, randomToken, toArrayBuffer, toBase64 } from '../shared/helpers/codec';
import { deriveSharedBits, deriveTransportKeys, exportEcdhPublicKey, generateEcdhKeyPair, importEcdhPublicKey, openEnvelope, sealEnvelope } from '../shared/helpers/transport-crypto';

import type { AckResponse, IReadItem, IReadResponse, IWritePayload, MReadItem, MReadResponse, MWritePayload, OpaqueEnvelope, SessionInitRequest, SessionInitResponse } from '../shared/types/crypto';

/** Hono に注入するバインディング */
type HonoBindings = {
  /** D1 Database */
  DB: D1Database;
  /** DB 暗号化に使用するマスターキー */
  DB_MASTER_KEY: string;
};

/** セッション情報 */
type SessionState = {
  /** Session ID */
  s: string;
  /** セッション有効期限 */
  e: number;
  /** 受信側の最新連番 */
  rx: number;
  /** 送信側の最新連番 */
  tx: number;
  /** 位置チャネル鍵 */
  i: CryptoKey;
  /** 文字列チャネル鍵 */
  m: CryptoKey;
};

/** DB 暗号化カラム */
type DbCipher = {
  /** 暗号文 */
  d: string;
  /** 初期化ベクトル */
  v: string;
};

/** 位置テーブルの取得行 */
type DbI = {
  /** Group ID */
  g: string;
  /** 暗号文 */
  d: string;
  /** 初期化ベクトル */
  v: string;
  /** 更新時刻 */
  u: number;
};

/** 文字列テーブルの取得行 */
type DbM = {
  /** Group ID */
  g: string;
  /** 暗号文 */
  d: string;
  /** 初期化ベクトル */
  v: string;
  /** 更新時刻 */
  u: number;
};

/** アプリケーション本体 */
const app = new Hono<{ Bindings: HonoBindings; }>();

/** セッション有効期限 */
const sessionTtlMs = 5 * 60 * 1000;
/** 送受信時刻の許容差 */
const maxSkewMs = 30 * 1000;
/** 座標上限値 */
const gridLimit = 1_000_000;

/** セッション保持マップ */
const sessionMap = new Map<string, SessionState>();

/** テーブル初期化済みフラグ */
let tableReady = false;
/** DB 鍵キャッシュ */
let dbKeyCache: { raw: string; key: CryptoKey; } | null = null;
/** 単調増加時刻の前回値 */
let lastWriteStamp = 0;

/**
 * 単調増加する更新時刻を生成する
 * 
 * @return 更新時刻
 */
const nextWriteStamp = (): number => {
  const now = Date.now();
  if(now > lastWriteStamp) {
    lastWriteStamp = now;
  }
  else {
    lastWriteStamp += 1;
  }
  return lastWriteStamp;
};

/**
 * 文字列入力をトリムして検証する
 * 
 * @param value 検証対象
 * @param max 最大文字数
 * @return 正常時は文字列・異常時は `null`
 */
const sanitizeString = (value: unknown, max = 256): string | null => {
  if(typeof value !== 'string') return null;
  const trimmed = value.trim();
  if(trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
};

/**
 * メッセージ文字列を検証する
 * 
 * @param value 検証対象
 * @param max 最大文字数
 * @return 正常時は文字列・異常時は `null`
 */
const sanitizeMessage = (value: unknown, max = 2048): string | null => {
  if(typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
};

/**
 * 座標タプルを検証する
 * 
 * @param value 検証対象
 * @return 座標タプルなら `true`
 */
const isGridTuple = (value: unknown): value is [number, number] => {
  if(!Array.isArray(value) || value.length !== 2) return false;
  return value.every(item => Number.isInteger(item) && item >= -gridLimit && item <= gridLimit);
};

/** 期限切れセッションを破棄する */
const purgeExpiredSessions = (): void => {
  const now = Date.now();
  for(const [sid, session] of sessionMap) {
    if(session.e <= now) sessionMap.delete(sid);
  }
};

/**
 * 受信データを Envelope 形式へ変換する
 * 
 * @param value 受信データ
 * @return 正常時は Envelope・異常時は `null`
 */
const parseEnvelope = (value: unknown): OpaqueEnvelope | null => {
  if(typeof value !== 'object' || value === null) return null;
  const envelope = value as Partial<OpaqueEnvelope>;
  if(typeof envelope.s !== 'string' || typeof envelope.q !== 'number' || typeof envelope.t !== 'number' || typeof envelope.v !== 'string' || typeof envelope.c !== 'string') return null;
  return envelope as OpaqueEnvelope;
};

/**
 * マスターキー入力から 32 Byte の鍵素材を生成する
 * 
 * @param rawInput マスターキー入力
 * @return 32 Byte の鍵素材
 */
const resolveDbKeyMaterial = async (rawInput: string): Promise<Uint8Array> => {
  const trimmed = rawInput.trim();
  try {
    const bytes = fromBase64(trimmed);
    if(bytes.byteLength === 32) return bytes;
  }
  catch {
    // Base64 でない場合はハッシュ化へフォールバックする
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(trimmed));
  return new Uint8Array(hash);
};

/**
 * DB 暗号化鍵を取得する
 * 
 * @param rawInput マスターキー入力
 * @return AES-GCM 鍵
 */
const getDbMasterKey = async (rawInput: string): Promise<CryptoKey> => {
  if(dbKeyCache !== null && dbKeyCache.raw === rawInput) return dbKeyCache.key;
  const keyMaterial = await resolveDbKeyMaterial(rawInput);
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyMaterial), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  dbKeyCache = { raw: rawInput, key };
  return key;
};

/**
 * DB 保存用に文字列を暗号化する
 * 
 * @param plainText 暗号化対象
 * @param key 暗号鍵
 * @return 暗号文と初期化ベクトル
 */
const sealForDb = async (plainText: string, key: CryptoKey): Promise<DbCipher> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(new TextEncoder().encode(plainText)));
  return { d: toBase64(cipher), v: toBase64(iv) };
};

/**
 * DB 行を復号する
 * 
 * @param row DB 行
 * @param key 暗号鍵
 * @return 復号した値
 */
const openFromDb = async <T>(row: DbCipher, key: CryptoKey): Promise<T> => {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(fromBase64(row.v)) }, key, toArrayBuffer(fromBase64(row.d)));
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text) as T;
};

/**
 * 必要なテーブルを初期化する
 * 
 * @param db D1 Database
 */
const ensureTables = async (db: D1Database): Promise<void> => {
  if(tableReady) return;
  
  // 位置テーブル
  // - `g` : 位置と文字列をマージするための Group ID
  // - `d` : 位置
  // - `v` : IV
  // - `u` : 更新時刻
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS k_i (
      g  TEXT     PRIMARY KEY,
      d  TEXT     NOT NULL,
      v  TEXT     NOT NULL,
      u  INTEGER  NOT NULL
    )
  `).run();
  
  // 文字列テーブル
  // - `g` : 位置と文字列をマージするための Group ID
  // - `d` : 文字列
  // - `v` : IV
  // - `u` : 更新時刻
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS k_m (
      g  TEXT     PRIMARY KEY,
      d  TEXT     NOT NULL,
      v  TEXT     NOT NULL,
      u  INTEGER  NOT NULL
    )
  `).run();
  
  tableReady = true;
};

/**
 * セッションを読み出す
 * 
 * @param sid Session ID
 * @return セッション情報・無効時は `null`
 */
const readSession = (sid: string): SessionState | null => {
  purgeExpiredSessions();
  const session = sessionMap.get(sid) ?? null;
  if(session === null) return null;
  if(session.e <= Date.now()) {
    sessionMap.delete(sid);
    return null;
  }
  return session;
};

/**
 * 暗号化 Payload を復号して検証する
 * 
 * @param envelope 受信 Envelope
 * @param session セッション情報
 * @param channel 使用チャネル
 * @param path API パス
 * @return 復号した Payload・異常時は `null`
 */
const readEncryptedPayload = async <T>(envelope: OpaqueEnvelope, session: SessionState, channel: 'i' | 'm', path: string): Promise<T | null> => {
  if(envelope.q <= session.rx) return null;
  try {
    const key = channel === 'i' ? session.i : session.m;
    const payload = await openEnvelope<T>(envelope, key, { p: path, m: 'POST', s: maxSkewMs });
    session.rx = envelope.q;
    return payload;
  }
  catch {
    return null;
  }
};

/**
 * レスポンス Payload を暗号化する
 * 
 * @param session セッション情報
 * @param channel 使用チャネル
 * @param path API パス
 * @param payload 送信 Payload
 * @return 暗号化済み Envelope
 */
const sealEncryptedResponse = async <T>(session: SessionState, channel: 'i' | 'm', path: string, payload: T): Promise<OpaqueEnvelope> => {
  session.tx += 1;
  const key = channel === 'i' ? session.i : session.m;
  return sealEnvelope(payload, key, { s: session.s, q: session.tx, p: path, m: 'POST' });
};

/** セッション初期化 API */
app.post(o.a, async context => {
  const body = await context.req.json<SessionInitRequest | unknown>().catch(() => null);
  const clientKeyRaw = sanitizeString((body as SessionInitRequest | null)?.k, 4096);
  if(clientKeyRaw === null) return context.json({ x: 0 }, 400);  // `x` は NG を示すダミー値
  
  const serverKeyPair = await generateEcdhKeyPair();
  const clientPublicKey = await importEcdhPublicKey(clientKeyRaw).catch(() => null);
  if(clientPublicKey === null) return context.json({ x: 0 }, 400);
  
  const sharedBits = await deriveSharedBits(serverKeyPair.privateKey, clientPublicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveTransportKeys(sharedBits, salt);
  
  const sid = randomToken(16);
  const expiresAt = Date.now() + sessionTtlMs;
  sessionMap.set(sid, { s: sid, e: expiresAt, rx: 0, tx: 0, i: keys.i, m: keys.m });
  
  const response: SessionInitResponse = {
    s: sid,
    k: await exportEcdhPublicKey(serverKeyPair.publicKey),
    n: toBase64(salt),
    e: expiresAt
  };
  return context.json(response);
});

/** 位置登録 API */
app.post(o.u, async context => {
  await ensureTables(context.env.DB);
  
  const envelopeRaw = await context.req.json<unknown>().catch(() => null);
  const envelope = parseEnvelope(envelopeRaw);
  if(envelope === null) return context.json({ x: 0 }, 400);
  
  const session = readSession(envelope.s);
  if(session === null) return context.json({ x: 0 }, 401);
  
  const payload = await readEncryptedPayload<IWritePayload>(envelope, session, 'i', o.u);
  if(payload === null) return context.json({ x: 0 }, 400);
  
  const g = sanitizeString(payload.g, 128);
  if(g === null || !isGridTuple(payload.i)) return context.json({ x: 0 }, 400);
  
  const dbSecretRaw = sanitizeString(context.env.DB_MASTER_KEY, 4096);
  if(dbSecretRaw === null) return context.json({ x: 0 }, 500);
  
  const dbKey = await getDbMasterKey(dbSecretRaw);
  const encrypted = await sealForDb(JSON.stringify(payload.i), dbKey);
  
  await context.env.DB
    .prepare('INSERT INTO k_i (g, d, v, u) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(g) DO UPDATE SET d = excluded.d, v = excluded.v, u = excluded.u')
    .bind(g, encrypted.d, encrypted.v, nextWriteStamp())
    .run();
  
  const ack: AckResponse = { o: 1 };
  const responseEnvelope = await sealEncryptedResponse(session, 'i', o.u, ack);
  return context.json(responseEnvelope);
});

/** 文字列登録 API */
app.post(o.v, async context => {
  await ensureTables(context.env.DB);
  
  const envelopeRaw = await context.req.json<unknown>().catch(() => null);
  const envelope = parseEnvelope(envelopeRaw);
  if(envelope === null) return context.json({ x: 0 }, 400);
  
  const session = readSession(envelope.s);
  if(session === null) return context.json({ x: 0 }, 401);
  
  const payload = await readEncryptedPayload<MWritePayload>(envelope, session, 'm', o.v);
  if(payload === null) return context.json({ x: 0 }, 400);
  
  const g = sanitizeString(payload.g, 128);
  if(g === null || typeof payload.m !== 'string') return context.json({ x: 0 }, 400);
  
  // 半角スペースは「その座標の値を削除」の命令として扱う
  if(payload.m === ' ') {
    await context.env.DB.prepare('DELETE FROM k_m WHERE g = ?1').bind(g).run();
    await context.env.DB.prepare('DELETE FROM k_i WHERE g = ?1').bind(g).run();
    
    const ack: AckResponse = { o: 1 };
    const responseEnvelope = await sealEncryptedResponse(session, 'm', o.v, ack);
    return context.json(responseEnvelope);
  }
  
  const m = sanitizeMessage(payload.m, 2048);
  if(m === null) return context.json({ x: 0 }, 400);
  
  const dbSecretRaw = sanitizeString(context.env.DB_MASTER_KEY, 4096);
  if(dbSecretRaw === null) return context.json({ x: 0 }, 500);
  
  const dbKey = await getDbMasterKey(dbSecretRaw);
  const encrypted = await sealForDb(JSON.stringify(m), dbKey);
  
  await context.env.DB
    .prepare('INSERT INTO k_m (g, d, v, u) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(g) DO UPDATE SET d = excluded.d, v = excluded.v, u = excluded.u')
    .bind(g, encrypted.d, encrypted.v, nextWriteStamp())
    .run();
  
  const ack: AckResponse = { o: 1 };
  const responseEnvelope = await sealEncryptedResponse(session, 'm', o.v, ack);
  return context.json(responseEnvelope);
});

/** 位置取得 API */
app.post(o.i, async context => {
  await ensureTables(context.env.DB);
  
  const envelopeRaw = await context.req.json<unknown>().catch(() => null);
  const envelope = parseEnvelope(envelopeRaw);
  if(envelope === null) return context.json({ x: 0 }, 400);
  
  const session = readSession(envelope.s);
  if(session === null) return context.json({ x: 0 }, 401);
  
  const probe = await readEncryptedPayload<Record<string, unknown>>(envelope, session, 'i', o.i);
  if(probe === null) return context.json({ x: 0 }, 400);
  
  const dbSecretRaw = sanitizeString(context.env.DB_MASTER_KEY, 4096);
  if(dbSecretRaw === null) return context.json({ x: 0 }, 500);
  
  const dbKey = await getDbMasterKey(dbSecretRaw);
  const rows = await context.env.DB
    .prepare('SELECT g, d, v, u FROM k_i ORDER BY u DESC')
    .all<DbI>();
  
  const values: Array<IReadItem> = [];
  for(const row of rows.results) {
    const i = await openFromDb<[number, number]>(row, dbKey).catch(() => null);
    if(i !== null && isGridTuple(i)) values.push({ g: row.g, i, u: row.u });
  }
  
  const responsePayload: IReadResponse = { a: values };
  const responseEnvelope = await sealEncryptedResponse(session, 'i', o.i, responsePayload);
  return context.json(responseEnvelope);
});

/** 文字列取得 API */
app.post(o.m, async context => {
  await ensureTables(context.env.DB);
  
  const envelopeRaw = await context.req.json<unknown>().catch(() => null);
  const envelope = parseEnvelope(envelopeRaw);
  if(envelope === null) return context.json({ x: 0 }, 400);
  
  const session = readSession(envelope.s);
  if(session === null) return context.json({ x: 0 }, 401);
  
  const probe = await readEncryptedPayload<Record<string, unknown>>(envelope, session, 'm', o.m);
  if(probe === null) return context.json({ x: 0 }, 400);
  
  const dbSecretRaw = sanitizeString(context.env.DB_MASTER_KEY, 4096);
  if(dbSecretRaw === null) return context.json({ x: 0 }, 500);
  
  const dbKey = await getDbMasterKey(dbSecretRaw);
  const rows = await context.env.DB
    .prepare('SELECT g, d, v, u FROM k_m ORDER BY u DESC')
    .all<DbM>();
  
  const values: Array<MReadItem> = [];
  for(const row of rows.results) {
    const m = await openFromDb<string>(row, dbKey).catch(() => null);
    if(m !== null) values.push({ g: row.g, m, u: row.u });
  }
  
  const responsePayload: MReadResponse = { a: values };
  const responseEnvelope = await sealEncryptedResponse(session, 'm', o.m, responsePayload);
  return context.json(responseEnvelope);
});

export default app;

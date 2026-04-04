/** 暗号化に使用する Envelope */
export type OpaqueEnvelope = {
  /** Session ID */
  s: string;
  /** 連番 */
  q: number;
  /** 送信時刻 */
  t: number;
  /** 初期化ベクトル */
  v: string;
  /** 暗号文 */
  c: string;
};

/** セッション初期化 API のリクエスト */
export type SessionInitRequest = {
  /** ECDH 公開鍵 */
  k: string;
};

/** セッション初期化 API のレスポンス */
export type SessionInitResponse = {
  /** Session ID */
  s: string;
  /** サーバ公開鍵 */
  k: string;
  /** HKDF の Salt */
  n: string;
  /** セッション有効期限 */
  e: number;
};

/** 位置登録 API の Payload */
export type IWritePayload = {
  /** 位置と文字列をマージするための Group ID */
  g: string;
  /** 行と列 */
  i: [number, number];
};

/** 文字列登録 API の Payload */
export type MWritePayload = {
  /** 位置と文字列をマージするための Group ID */
  g: string;
  /** 文字列 */
  m: string;
};

/** 位置取得 API の単一要素 */
export type IReadItem = IWritePayload & {
  /** 更新時刻 */
  u: number;
};

/** 文字列取得 API の単一要素 */
export type MReadItem = MWritePayload & {
  /** 更新時刻 */
  u: number;
};

/** 位置取得 API のレスポンス */
export type IReadResponse = {
  /** 位置要素の配列 */
  a: Array<IReadItem>;
};

/** 文字列取得 API のレスポンス */
export type MReadResponse = {
  /** 文字列要素の配列 */
  a: Array<MReadItem>;
};

/** 登録 API の成功レスポンス */
export type AckResponse = {
  /** 成功を示す値 */
  o: 1;
};

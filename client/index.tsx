import ky, { HTTPError } from 'ky';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
  type WheelEvent
} from 'react';

import { o } from '../shared/constants/opaque-api';
import { fromBase64 } from '../shared/helpers/codec';
import {
  deriveSharedBits,
  deriveTransportKeys,
  exportEcdhPublicKey,
  generateEcdhKeyPair,
  importEcdhPublicKey,
  openEnvelope,
  sealEnvelope
} from '../shared/helpers/transport-crypto';

import type {
  AckResponse,
  IReadResponse,
  IWritePayload,
  MReadResponse,
  MWritePayload,
  OpaqueEnvelope,
  SessionInitResponse
} from '../shared/types/crypto';

/** 通信セッション状態 */
type SessionState = {
  /** Session ID */
  s: string;
  /** 連番 */
  q: number;
  /** 位置チャネル鍵 */
  i: CryptoKey;
  /** 文字列チャネル鍵 */
  m: CryptoKey;
};

/** 描画対象の確定セル情報 */
type BoardCell = {
  /** Group ID */
  g: string;
  /** 行列座標 */
  i: [number, number];
  /** 文字列 */
  m: string;
  /** 更新時刻 */
  u: number;
};

/** 位置と文字列の片側だけが届いた中間状態 */
type PartialBoardCell = {
  /** Group ID */
  g: string;
  /** 行列座標 */
  i: [number, number] | null;
  /** 文字列 */
  m: string;
  /** 更新時刻 */
  u: number;
};

/** カーソル座標 */
type Cursor = {
  /** 行 */
  r: number;
  /** 列 */
  c: number;
};

/** 表示オフセット */
type ViewportOffset = {
  /** X 方向オフセット */
  x: number;
  /** Y 方向オフセット */
  y: number;
};

/** 仮想セルマップへ展開した1セル分の情報 */
type PlacedCell = {
  /** 表示文字・後続セル (`t`) は空文字 */
  ch: string;
  /** 文字幅 */
  w: 1 | 2;
  /** 全角文字の後続セルか否か */
  t: boolean;
  /** 文字の先頭セル列 */
  h: number;
};

/** セル幅 */
const cellW = 12;
/** セル高さ */
const cellH = 22;
/** 一度に処理する最大文字数 */
const maxInsertCharacters = 256;

/**
 * 文字幅を返す
 * 
 * @param value 判定対象文字
 * @return 半角なら 1・全角なら 2
 */
const getCharWidth = (value: string): 1 | 2 => {
  const code = value.codePointAt(0) ?? 0;
  return code <= 0x007f ? 1 : 2;
};

/**
 * 文字列を 1 文字単位へ分割する
 * 
 * @param text 分割対象文字列
 * @return 1 文字ごとの配列
 */
const splitChars = (text: string): Array<string> => Array.from(text);

/**
 * 座標から Group ID を生成する
 * 
 * @param r 行
 * @param c 列
 * @return Group ID
 */
const makeGroupId = (r: number, c: number): string => `${r.toString(36)}_${c.toString(36)}`;

/**
 * 座標からマップキーを生成する
 * 
 * @param r 行
 * @param c 列
 * @return マップキー
 */
const makeCellKey = (r: number, c: number): string => `${r}:${c}`;

/**
 * 入力文字列を正規化する
 * 
 * @param text 正規化対象
 * @return 改行除去と長さ制限を適用した文字列
 */
const normalizeInsertText = (text: string): string => {
  const squashed = text.replaceAll('\r', '').replaceAll('\n', '').replaceAll('\t', ' ');
  return splitChars(squashed).slice(0, maxInsertCharacters).join('');
};

/**
 * 401 エラーか否かを判定する
 * 
 * @param error 判定対象
 * @return 401 エラーなら `true`
 */
const isUnauthorizedError = (error: unknown): boolean => {
  return error instanceof HTTPError && error.response.status === 401;
};

/**
 * 先頭セルを削除する
 * 
 * @param map 仮想セルマップ
 * @param r 行
 * @param headC 先頭セル列
 */
const clearHeadAt = (map: Map<string, PlacedCell>, r: number, headC: number): void => {
  const head = map.get(makeCellKey(r, headC));
  if(head === undefined) return;
  
  map.delete(makeCellKey(r, headC));
  if(head.w === 2) {
    const tailKey = makeCellKey(r, headC + 1);
    const tail = map.get(tailKey);
    if(tail !== undefined && tail.t && tail.h === headC) map.delete(tailKey);
  }
};

/**
 * 1 文字を仮想セルマップへ適用する
 * 
 * @param map 仮想セルマップ
 * @param r 行
 * @param c 列
 * @param ch 文字
 */
const applyGlyphToMap = (map: Map<string, PlacedCell>, r: number, c: number, ch: string): void => {
  const width = getCharWidth(ch);
  
  const current = map.get(makeCellKey(r, c));
  if(current !== undefined) clearHeadAt(map, r, current.t ? current.h : c);
  
  if(width === 2) {
    const right = map.get(makeCellKey(r, c + 1));
    if(right !== undefined) clearHeadAt(map, r, right.t ? right.h : c + 1);
  }
  
  map.set(makeCellKey(r, c), {
    ch,
    w: width,
    t: false,
    h: c
  });
  
  if(width === 2) {
    map.set(makeCellKey(r, c + 1), {
      ch: '',
      w: 2,
      t: true,
      h: c
    });
  }
};

/**
 * 画面
 * 
 * @return React 要素
 */
export default function Index(): ReactNode {
  const sessionRef = useRef<SessionState | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<Cursor>({ r: 0, c: 0 });
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionRefreshRef = useRef<Promise<void> | null>(null);
  const isWritingRef = useRef<boolean>(false);
  const isComposingRef = useRef<boolean>(false);
  const lastImeCommitRef = useRef<{ text: string; at: number; }>({ text: '', at: 0 });
  const lastCompositionCommitAtRef = useRef<number>(0);
  const viewRef = useRef<ViewportOffset>({ x: 0, y: 0 });
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number; } | null>(null);
  const touchPanRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; } | null>(null);
  
  const [items, setItems] = useState<Array<BoardCell>>([]);
  const [cursor, setCursor] = useState<Cursor>({ r: 0, c: 0 });
  const [isActive, setIsActive] = useState<boolean>(false);
  const [textareaValue, setTextareaValue] = useState<string>('');
  const [viewport, setViewport] = useState<{ w: number; h: number; }>({ w: 1, h: 1 });  // 画面サイズから自動算出させる
  const [view, setView] = useState<ViewportOffset>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  
  /**
   * 表示オフセットを更新する
   * 
   * @param next 更新候補値
   */
  const updateView = useCallback((next: ViewportOffset): void => {
    const clamped = {
      x: Math.max(0, next.x),
      y: Math.max(0, next.y)
    };
    viewRef.current = clamped;
    setView(clamped);
  }, []);
  
  /**
   * カーソルが画面内に入るよう表示オフセットを補正する
   * 
   * @param nextCursor 補正対象カーソル
   */
  const ensureCursorVisible = useCallback((nextCursor: Cursor): void => {
    const cellX = nextCursor.c * cellW;
    const cellY = nextCursor.r * cellH;
    const maxX = Math.max(0, viewport.w - cellW);
    const maxY = Math.max(0, viewport.h - cellH);
    
    let x = viewRef.current.x;
    let y = viewRef.current.y;
    
    if(cellX < x) {
      x = cellX;
    }
    else if(cellX > x + maxX) {
      x = cellX - maxX;
    }
    
    if(cellY < y) {
      y = cellY;
    }
    else if(cellY > y + maxY) {
      y = cellY - maxY;
    }
    
    updateView({ x, y });
  }, [updateView, viewport.h, viewport.w]);
  
  /** セッションを新規生成する */
  const createSession = useCallback(async (): Promise<void> => {
    const clientPair = await generateEcdhKeyPair();
    const clientPublicKey = await exportEcdhPublicKey(clientPair.publicKey);
    
    const sessionInit = await ky.post(o.a, {
      json: {
        k: clientPublicKey
      }
    }).json<SessionInitResponse>();
    
    const serverPublicKey = await importEcdhPublicKey(sessionInit.k);
    const sharedBits = await deriveSharedBits(clientPair.privateKey, serverPublicKey);
    const keys = await deriveTransportKeys(sharedBits, fromBase64(sessionInit.n));
    
    sessionRef.current = {
      s: sessionInit.s,
      q: 0,
      i: keys.i,
      m: keys.m
    };
  }, []);
  
  /** セッションを再取得する */
  const refreshSession = useCallback(async (): Promise<void> => {
    if(sessionRefreshRef.current === null) {
      sessionRefreshRef.current = createSession().finally(() => {
        sessionRefreshRef.current = null;
      });
    }
    await sessionRefreshRef.current;
  }, [createSession]);
  
  /**
   * 暗号化通信を実行する
   * 
   * @param path API パス
   * @param channel 使用チャネル
   * @param payload 送信 Payload
   * @return 復号したレスポンス
   */
  const withEncryptedCall = useCallback(async <TRequest, TResponse>(path: string, channel: 'i' | 'm', payload: TRequest): Promise<TResponse> => {
    const execute = async (): Promise<TResponse> => {
      if(sessionRef.current === null) await refreshSession();
      
      const session = sessionRef.current;
      if(session === null) throw new Error('Session Unavailable');
      
      session.q += 1;
      const key = channel === 'i' ? session.i : session.m;
      
      const requestEnvelope = await sealEnvelope(payload, key, {
        s: session.s,
        q: session.q,
        p: path,
        m: 'POST'
      });
      
      const responseEnvelope = await ky.post(path, { json: requestEnvelope }).json<OpaqueEnvelope>();
      return openEnvelope<TResponse>(responseEnvelope, key, {
        p: path,
        m: 'POST',
        s: 60 * 1000
      });
    };
    
    try {
      return await execute();
    }
    catch(error) {
      if(!isUnauthorizedError(error)) throw error;
      sessionRef.current = null;
      await refreshSession();
      return execute();
    }
  }, [refreshSession]);
  
  /** サーバから盤面を同期する */
  const syncBoard = useCallback(async (): Promise<void> => {
    const iResult = await withEncryptedCall<Record<string, number>, IReadResponse>(o.i, 'i', { x: 1 });
    const mResult = await withEncryptedCall<Record<string, number>, MReadResponse>(o.m, 'm', { x: 1 });
    
    const map = new Map<string, PartialBoardCell>();
    
    for(const item of iResult.a) {
      map.set(item.g, {
        g: item.g,
        i: item.i,
        m: map.get(item.g)?.m ?? '',
        u: Math.max(item.u, map.get(item.g)?.u ?? 0)
      });
    }
    
    for(const item of mResult.a) {
      const current = map.get(item.g);
      map.set(item.g, {
        g: item.g,
        i: current?.i ?? null,
        m: item.m,
        u: Math.max(item.u, current?.u ?? 0)
      });
    }
    
    const merged = Array.from(map.values())
      .filter((value): value is BoardCell => value.m.length > 0 && value.i !== null)
      .sort((a, b) => (a.u - b.u) || (a.i[0] - b.i[0]) || (a.i[1] - b.i[1]));
    
    setItems(merged);
  }, [withEncryptedCall]);
  
  /**
   * 1 文字をサーバへ登録する
   * 
   * @param r 行
   * @param c 列
   * @param m 文字列
   */
  const postGlyph = useCallback(async (r: number, c: number, m: string): Promise<void> => {
    const g = makeGroupId(r, c);
    
    const iPayload: IWritePayload = { g, i: [r, c] };
    const mPayload: MWritePayload = { g, m };
    
    // NOTE : 並列実行すると連番が狂って登録が失敗するので必ず直列実行する
    await withEncryptedCall<IWritePayload, AckResponse>(o.u, 'i', iPayload);
    await withEncryptedCall<MWritePayload, AckResponse>(o.v, 'm', mPayload);
  }, [withEncryptedCall]);
  
  /** 初期化処理を実行する */
  const initialize = useCallback(async (): Promise<void> => {
    await refreshSession();
    await syncBoard();
  }, [refreshSession, syncBoard]);
  
  /**
   * 描画用のセルマップを生成する
   * 
   * @return 仮想セルマップ
   */
  const placedMap = useMemo(() => {
    const map = new Map<string, PlacedCell>();
    
    for(const item of items) {
      let c = item.i[1];
      for(const ch of splitChars(item.m)) {
        applyGlyphToMap(map, item.i[0], c, ch);
        c += getCharWidth(ch);
      }
    }
    
    return map;
  }, [items]);
  
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  
  useEffect((): () => void => {
    /** 画面サイズに追従して描画サイズを更新する */
    const resize = (): void => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      setViewport({ w: width, h: height });
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);
  
  useEffect(() => {
    initialize().catch(() => { /* 初期化エラーは UI へ表示しない */ });
  }, [initialize]);
  
  useEffect((): () => void => {
    const timer = window.setInterval(() => {
      if(sessionRef.current === null || isWritingRef.current) return;
      syncBoard().catch(() => { /* ポーリングエラーは UI へ表示しない */ });
    }, 5000);
    
    return () => {
      window.clearInterval(timer);
    };
  }, [syncBoard]);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if(canvas === null) return;
    
    const ctx = canvas.getContext('2d');
    if(ctx === null) return;
    
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.w * ratio);
    canvas.height = Math.floor(viewport.h * ratio);
    canvas.style.width = `${viewport.w}px`;
    canvas.style.height = `${viewport.h}px`;
    
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewport.w, viewport.h);
    
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, viewport.w, viewport.h);
    
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for(let x = 0; x <= viewport.w; x += cellW) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, viewport.h);
      ctx.stroke();
    }
    for(let y = 0; y <= viewport.h; y += cellH) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(viewport.w, y + 0.5);
      ctx.stroke();
    }
    
    if(isActive) {
      ctx.fillStyle = '#fe0';
      ctx.fillRect(cursor.c * cellW - view.x, cursor.r * cellH - view.y, cellW, cellH);
      ctx.strokeStyle = '#fe0';
      ctx.strokeRect(cursor.c * cellW - view.x + 0.5, cursor.r * cellH - view.y + 0.5, cellW - 1, cellH - 1);
    }
    
    ctx.fillStyle = '#000';
    ctx.font = '16px "M PLUS 1 Code", "Noto Sans Mono CJK JP", Osaka-mono, "MS Gothic", Menlo, Consolas, Courier, "Courier New", monospace, "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"';
    ctx.textBaseline = 'top';
    
    for(const [key, value] of placedMap) {
      if(value.t || value.ch.length === 0) continue;
      
      const [rowRaw, colRaw] = key.split(':');
      const row = Number.parseInt(rowRaw ?? '0', 10);
      const col = Number.parseInt(colRaw ?? '0', 10);
      const x = col * cellW - view.x;
      const y = row * cellH - view.y;
      if(x < -cellW || y < -cellH || x > viewport.w || y > viewport.h) continue;
      ctx.fillText(value.ch, x + 1, y + 2);
    }
  }, [isActive, cursor.c, cursor.r, placedMap, view.x, view.y, viewport.h, viewport.w]);
  
  /**
   * 入力文字列を順次送信する
   * 
   * @param text 入力文字列
   */
  const enqueueTextInsert = useCallback((text: string): void => {
    const normalized = normalizeInsertText(text);
    if(normalized.length === 0) return;
    
    writeQueueRef.current = writeQueueRef.current
      .then(async () => {
        isWritingRef.current = true;
        
        const workingMap = new Map<string, PlacedCell>(placedMap);
        let workCursor = cursorRef.current;
        const writeMap = new Map<string, { r: number; c: number; m: string; }>();
        
        const pushWrite = (r: number, c: number, m: string): void => {
          const g = makeGroupId(r, c);
          writeMap.set(g, { r, c, m });
        };
        
        for(const ch of splitChars(normalized)) {
          const width = getCharWidth(ch);
          const before = workingMap.get(makeCellKey(workCursor.r, workCursor.c));
          
          if(before !== undefined && before.t) {
            const leftCol = before.h;
            applyGlyphToMap(workingMap, workCursor.r, leftCol, ' ');
            pushWrite(workCursor.r, leftCol, ' ');
          }
          
          if(width === 2) {
            const right = workingMap.get(makeCellKey(workCursor.r, workCursor.c + 1));
            if(right !== undefined) {
              const clearCol = right.t ? right.h : workCursor.c + 1;
              if(clearCol !== workCursor.c) {
                applyGlyphToMap(workingMap, workCursor.r, clearCol, ' ');
                pushWrite(workCursor.r, clearCol, ' ');
              }
            }
          }
          
          applyGlyphToMap(workingMap, workCursor.r, workCursor.c, ch);
          pushWrite(workCursor.r, workCursor.c, ch);
          
          workCursor = { r: workCursor.r, c: workCursor.c + width };
        }
        
        if(writeMap.size > 0) {
          const stamp = Date.now();
          const localWrites = Array.from(writeMap.entries()).map(([g, value]) => ({
            g,
            i: [value.r, value.c] as [number, number],
            m: value.m,
            u: stamp
          }));
          setItems(previous => {
            const writeIds = new Set(localWrites.map(value => value.g));
            const next = previous.filter(value => !writeIds.has(value.g));
            next.push(...localWrites);
            return next;
          });
        }
        
        cursorRef.current = workCursor;
        setCursor(workCursor);
        ensureCursorVisible(workCursor);
        
        for(const value of writeMap.values()) await postGlyph(value.r, value.c, value.m);
        
        isWritingRef.current = false;
      })
      .catch(() => {
        isWritingRef.current = false;
      });
  }, [ensureCursorVisible, placedMap, postGlyph]);
  
  /**
   * 現在カーソル位置の文字を削除する
   * 
   * @param withBackspace `true` のとき削除後にカーソルを左へ移動する
   */
  const enqueueEraseAtCursor = useCallback((withBackspace: boolean): void => {
    writeQueueRef.current = writeQueueRef.current
      .then(async () => {
        isWritingRef.current = true;
        
        const workingMap = new Map<string, PlacedCell>(placedMap);
        let workCursor = cursorRef.current;
        const current = workingMap.get(makeCellKey(workCursor.r, workCursor.c));
        let eraseWrite: { g: string; r: number; c: number; m: string; } | null = null;
        
        if(current !== undefined) {
          const headC = current.t ? current.h : workCursor.c;
          applyGlyphToMap(workingMap, workCursor.r, headC, ' ');
          eraseWrite = { g: makeGroupId(workCursor.r, headC), r: workCursor.r, c: headC, m: ' ' };
        }
        
        if(eraseWrite !== null) {
          setItems(previous => {
            const next = previous.filter(value => value.g !== eraseWrite?.g);
            next.push({ g: eraseWrite.g, i: [eraseWrite.r, eraseWrite.c], m: eraseWrite.m, u: Date.now() });
            return next;
          });
        }
        
        if(withBackspace) {
          workCursor = { r: workCursor.r, c: Math.max(0, workCursor.c - 1) };
          cursorRef.current = workCursor;
          setCursor(workCursor);
          ensureCursorVisible(workCursor);
        }
        
        if(eraseWrite !== null) await postGlyph(eraseWrite.r, eraseWrite.c, eraseWrite.m);
        
        isWritingRef.current = false;
      })
      .catch(() => {
        isWritingRef.current = false;
      });
  }, [ensureCursorVisible, placedMap, postGlyph]);
  
  /**
   * 盤面クリック時の処理
   * 
   * @param event マウスイベント
   */
  const onBoardClick = (event: MouseEvent<HTMLDivElement>): void => {
    if(isWritingRef.current) return;
    const target = event.currentTarget.getBoundingClientRect();
    const c = Math.max(0, Math.floor((event.clientX - target.left + viewRef.current.x) / cellW));
    const r = Math.max(0, Math.floor((event.clientY - target.top + viewRef.current.y) / cellH));
    const next = { r, c };
    setCursor(next);
    cursorRef.current = next;
    setIsActive(true);
    ensureCursorVisible(next);
    textareaRef.current?.focus();
  };
  
  /**
   * タップ位置をカーソルへ反映する
   * 
   * @param clientX 画面 X 座標
   * @param clientY 画面 Y 座標
   */
  const moveCursorAtPoint = useCallback((clientX: number, clientY: number): void => {
    if(isWritingRef.current) return;
    const board = boardRef.current;
    if(board === null) return;
    const target = board.getBoundingClientRect();
    const c = Math.max(0, Math.floor((clientX - target.left + viewRef.current.x) / cellW));
    const r = Math.max(0, Math.floor((clientY - target.top + viewRef.current.y) / cellH));
    const next = { r, c };
    setCursor(next);
    cursorRef.current = next;
    setIsActive(true);
    ensureCursorVisible(next);
    textareaRef.current?.focus();
  }, [ensureCursorVisible]);
  
  /**
   * ホイールスクロール処理
   * 
   * @param event ホイールイベント
   */
  const onBoardWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const dx = event.shiftKey ? event.deltaY : event.deltaX;
    const dy = event.shiftKey ? 0 : event.deltaY;
    updateView({
      x: viewRef.current.x + dx,
      y: viewRef.current.y + dy
    });
  };
  
  /**
   * 中クリックによるパン開始処理
   * 
   * @param event マウスイベント
   */
  const onBoardMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if(event.button !== 1) return;
    event.preventDefault();
    setIsPanning(true);
    panRef.current = {
      sx: event.clientX,
      sy: event.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y
    };
    textareaRef.current?.focus();
  };
  
  /**
   * タッチ開始時の処理
   * 
   * @param event タッチイベント
   */
  const onBoardTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    if(event.touches.length !== 1) return;
    const touch = event.touches[0];
    if(touch === undefined) return;
    touchPanRef.current = {
      id: touch.identifier,
      sx: touch.clientX,
      sy: touch.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y,
      moved: false
    };
  };
  
  /**
   * タッチ移動時の処理
   * 
   * @param event タッチイベント
   */
  const onBoardTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
    const pan = touchPanRef.current;
    if(pan === null) return;
    const touch = Array.from(event.touches).find(value => value.identifier === pan.id);
    if(touch === undefined) return;
    const dx = touch.clientX - pan.sx;
    const dy = touch.clientY - pan.sy;
    if(!pan.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      pan.moved = true;
      setIsPanning(true);
    }
    if(!pan.moved) return;
    event.preventDefault();
    updateView({
      x: pan.ox - dx,
      y: pan.oy - dy
    });
  };
  
  /**
   * タッチ終了時の処理
   * 
   * @param event タッチイベント
   */
  const onBoardTouchEnd = (event: TouchEvent<HTMLDivElement>): void => {
    const pan = touchPanRef.current;
    if(pan === null) return;
    const touch = Array.from(event.changedTouches).find(value => value.identifier === pan.id);
    if(touch === undefined) return;
    if(!pan.moved) moveCursorAtPoint(touch.clientX, touch.clientY);
    touchPanRef.current = null;
    setIsPanning(false);
  };
  
  /** タッチキャンセル時の処理 */
  const onBoardTouchCancel = (): void => {
    touchPanRef.current = null;
    setIsPanning(false);
  };
  
  useEffect(() => {
    /**
     * 中クリックによるパン中の移動処理
     * 
     * @param event マウスイベント
     */
    const onMouseMove = (event: globalThis.MouseEvent): void => {
      const pan = panRef.current;
      if(pan === null) return;
      const nextX = pan.ox - (event.clientX - pan.sx);
      const nextY = pan.oy - (event.clientY - pan.sy);
      updateView({ x: nextX, y: nextY });
    };
    
    /** 中クリックによるパン終了処理 */
    const onMouseUp = (): void => {
      panRef.current = null;
      setIsPanning(false);
    };
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [updateView]);
  
  /**
   * キー入力処理
   * 
   * @param event キーボードイベント
   */
  const onBoardKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if(!isActive) return;
    if(isWritingRef.current) return event.preventDefault();
    
    const isImeInput = isComposingRef.current
      || event.nativeEvent.isComposing
      || event.key === 'Process'
      || event.keyCode === 229;  // NOTE : IME 対応のためのハック https://developer.mozilla.org/ja/docs/Web/API/Element/keydown_event#keydown_%E3%82%A4%E3%83%99%E3%83%B3%E3%83%88%E3%81%A8_ime
    if(isImeInput) return;
    
    if(event.key === 'Delete') {
      enqueueEraseAtCursor(false);
      setTextareaValue('');
      return event.preventDefault();
    }
    if(event.key === 'Backspace') {
      enqueueEraseAtCursor(true);
      setTextareaValue('');
      return event.preventDefault();
    }
    
    if(event.key === 'ArrowLeft') {
      setCursor(previous => {
        const next = { ...previous, c: Math.max(0, previous.c - 1) };
        cursorRef.current = next;
        ensureCursorVisible(next);
        return next;
      });
      return event.preventDefault();
    }
    if(event.key === 'ArrowRight') {
      setCursor(previous => {
        const next = { ...previous, c: previous.c + 1 };
        cursorRef.current = next;
        ensureCursorVisible(next);
        return next;
      });
      return event.preventDefault();
    }
    if(event.key === 'ArrowUp') {
      setCursor(previous => {
        const next = { ...previous, r: Math.max(0, previous.r - 1) };
        cursorRef.current = next;
        ensureCursorVisible(next);
        return next;
      });
      return event.preventDefault();
    }
    if(event.key === 'ArrowDown') {
      setCursor(previous => {
        const next = { ...previous, r: previous.r + 1 };
        cursorRef.current = next;
        ensureCursorVisible(next);
        return next;
      });
      return event.preventDefault();
    }
    if(event.key === 'Enter') {
      setCursor(previous => {
        const next = { r: previous.r + 1, c: previous.c };
        cursorRef.current = next;
        ensureCursorVisible(next);
        return next;
      });
      return event.preventDefault();
    }
    
    if(event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    
    enqueueTextInsert(event.key);
    setTextareaValue('');
    event.preventDefault();
  }, [isActive, enqueueEraseAtCursor, enqueueTextInsert, ensureCursorVisible]);
  
  /** 入力バッファをクリアする */
  const clearTextareaBuffer = useCallback((): void => {
    const element = textareaRef.current;
    if(element !== null) element.value = '';
    setTextareaValue('');
  }, []);
  
  /**
   * IME 確定文字の反映処理
   * 
   * @param text 反映対象文字列
   */
  const commitTextFromIme = useCallback((text: string): void => {
    const normalized = normalizeInsertText(text);
    if(normalized.length === 0) {
      clearTextareaBuffer();
      return;
    }
    const now = Date.now();
    const recent = lastImeCommitRef.current;
    if(recent.text === normalized && (now - recent.at) <= 80) {
      clearTextareaBuffer();
      return;
    }
    lastImeCommitRef.current = { text: normalized, at: now };
    enqueueTextInsert(normalized);
    clearTextareaBuffer();
  }, [clearTextareaBuffer, enqueueTextInsert]);
  
  /** IME 合成開始時の処理 */
  const onCompositionStart = (): void => {
    if(isWritingRef.current) return;
    isComposingRef.current = true;
    clearTextareaBuffer();
  };
  
  /**
   * IME 合成確定時の処理
   * 
   * @param event Composition イベント
   */
  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>): void => {
    if(isWritingRef.current) return clearTextareaBuffer();
    isComposingRef.current = false;
    const fallback = textareaRef.current?.value ?? '';
    commitTextFromIme(event.data.length > 0 ? event.data : fallback);
    lastCompositionCommitAtRef.current = Date.now();
  };
  
  /**
   * beforeinput 処理
   *
   * @param event 入力イベント
   */
  const onTextareaBeforeInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    if(!isActive) return;
    if(isWritingRef.current) return event.preventDefault();
    const native = event.nativeEvent as InputEvent;
    const inputType = native.inputType ?? '';
    
    if(inputType === 'deleteContentBackward' || inputType === 'deleteContentForward' || inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      clearTextareaBuffer();
      return event.preventDefault();
    }
    
    if(!isComposingRef.current && inputType === 'insertText' && typeof native.data === 'string' && native.data.length > 0) {
      commitTextFromIme(native.data);
      event.preventDefault();
    }
  };
  
  /**
   * テキストエリア変更処理
   * 
   * @param event 変更イベント
   */
  const onTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>): void => setTextareaValue(event.target.value);
  
  /**
   * Input 処理 (iOS の Simeji 等で `compositionend` の `data` が空になるケースのフォールバック)
   * 
   * @param event 入力イベント
   */
  const onTextareaInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    const nextValue = event.currentTarget.value;
    setTextareaValue(nextValue);
    if(isWritingRef.current || isComposingRef.current) return;
    if((Date.now() - lastCompositionCommitAtRef.current) <= 80) return clearTextareaBuffer();
    commitTextFromIme(nextValue);
  };
  
  /**
   * ペースト処理
   * 
   * @param event クリップボードイベント
   */
  const onTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if(isWritingRef.current) return event.preventDefault();
    
    const pasted = normalizeInsertText(event.clipboardData.getData('text'));
    enqueueTextInsert(pasted);
    setTextareaValue('');
    event.preventDefault();
  };
  
  return (
    <main>
      <div
        ref={boardRef}
        onClick={onBoardClick}
        onWheel={onBoardWheel}
        onMouseDown={onBoardMouseDown}
        onTouchStart={onBoardTouchStart}
        onTouchMove={onBoardTouchMove}
        onTouchEnd={onBoardTouchEnd}
        onTouchCancel={onBoardTouchCancel}
        data-p={isPanning ? '1' : '0'}
      >
        <canvas ref={canvasRef} />
        <textarea
          ref={textareaRef}
          value={textareaValue}
          onChange={onTextareaChange}
          onBeforeInput={onTextareaBeforeInput}
          onInput={onTextareaInput}
          onKeyDown={onBoardKeyDown}
          onPaste={onTextareaPaste}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onFocus={() => { setIsActive(true); }}
          onBlur={() => { setIsActive(false); }}
          style={{
            left: cursor.c * cellW - view.x,
            top: cursor.r * cellH - view.y
          }}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
    </main>
  );
}

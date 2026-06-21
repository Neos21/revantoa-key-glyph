import { type ReactElement, type ReactNode } from 'react';
import { isRouteErrorResponse, Links, Outlet, Scripts, ScrollRestoration } from 'react-router';

import type { Route } from './+types/root';

import './styles.css';

/**
 * ルート全体の HTML レイアウトを定義する
 * 
 * @param children ルート配下の描画要素
 * @return HTML レイアウト
 */
export function Layout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="ja">
      <head>
        <meta charSet="UTF-8" />
        <title>KeyGlyph</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="theme-color" content="#d4af37" />
        <meta name="description" content="KeyGlyph" />
        <meta name="keywords" content="KeyGlyph" />
        <meta name="robots" content="index,follow" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="KeyGlyph" />
        <meta property="og:title" content="KeyGlyph" />
        <meta property="og:description" content="KeyGlyph" />
        <meta property="og:url" content="https://key-glyph.revantoa.workers.dev" />
        <meta property="og:image" content="https://key-glyph.revantoa.workers.dev/9Ll55ri2.png" />
        <meta property="og:locale" content="ja_JP" />
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="KeyGlyph" />
        <meta property="twitter:description" content="KeyGlyph" />
        <meta property="twitter:url" content="https://key-glyph.revantoa.workers.dev" />
        <meta property="twitter:image" content="https://key-glyph.revantoa.workers.dev/9Ll55ri2.png" />
        
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/5AYYnrgw.png" />
        <link rel="manifest" href="/PoND86Hl.webmanifest" />
        
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=M+PLUS+1+Code:wght@500&amp;display=swap" fetchPriority="high" />
        <link rel="stylesheet"         href="https://fonts.googleapis.com/css2?family=M+PLUS+1+Code:wght@500&amp;display=swap" fetchPriority="high" />
        
        <link rel="preconnect" href="https://challenges.cloudflare.com" />
        <link rel="preconnect" href="https://static.cloudflareinsights.com" />
        
        <Links />
        
        <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"483d6357e6af479caa3159bbe5edd9e8"}' />
      </head>
      <body suppressHydrationWarning>
        {children}
        
        <div id="l">
          <a href="https://colonet.revantoa.workers.dev" target="_blank">Colonet</a>
          <span>|</span>
          <a href="https://cipher-feed.revantoa.workers.dev" target="_blank">CipherFeed</a>
          <span>|</span>
          <a href="https://fight-for-your-right.revantoa.workers.dev" target="_blank">Fight For Your Right</a>
        </div>
        
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * ルートのマウント先
 * 
 * @return Outlet 要素
 */
export default function App(): ReactElement {
  return (<Outlet />);
}

/**
 * Hydration 前のフォールバック
 * 
 * @return 空要素
 */
export function HydrateFallback(): ReactElement {
  return (<></>);
}

/**
 * ルートエラー時の表示
 * 
 * @param error ルートエラー情報
 * @return エラー画面
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps): ReactElement {
  let title = 'Error';
  let text = 'An Error Occurred';
  if(isRouteErrorResponse(error) && error.status === 404) {
    title = '404';
    text = 'Not Found';
  }
  
  return (
    <main>
      <h1>{title}</h1>
      <p>{text}</p>
    </main>
  );
}

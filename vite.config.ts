import cloudflareAdapter from '@hono/vite-dev-server/cloudflare';
import { reactRouter } from '@react-router/dev/vite';
import serverAdapter from 'hono-react-router-adapter/vite';
import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig({
  plugins: [
    mkcert(),  // NOTE : `https://localhost:5173/` ではなく `https://192.168.1.7:5173/` でアクセスした時に Web Crypto API を有効にするため
    reactRouter(),
    serverAdapter({
      adapter: cloudflareAdapter,
      entry: './server/index.ts'
    })
  ],
  server: {
    host: true
  },
  build: {
    rollupOptions: {
      output: {  // なるべく内容が推測されないようにする
        entryFileNames: '[hash].js',
        chunkFileNames: '[hash].js',
        assetFileNames: '[hash].[ext]'
      }
    }
  }
});

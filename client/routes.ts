import { type RouteConfig, index } from '@react-router/dev/routes';

/** ルート定義 : パス情報がビルドコードに残るためファイルパスなどに注意 */
export default [
  index('./index.tsx')
] satisfies RouteConfig;

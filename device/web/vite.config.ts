import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

/**
 * 開発サーバーの決めごと。
 *
 * 既定は **127.0.0.1 の HTTP**。同じ機械のブラウザで開く前提で、
 * 外には出さない。
 *
 * 別の端末（iPad やスマホ、隣の機械）から開きたいときは
 * `npm run dev:lan` を使う。**HTTPS でなければならない。**
 *
 * `getUserMedia` は secure context でしか動かず、HTTP で secure context
 * とみなされるのは「ホスト名が localhost / *.localhost」か
 * 「ループバックの **IP リテラル**（127.0.0.1 / ::1）」のときだけ。
 * 判定は名前解決の結果ではなく**ホスト名の文字列**で行われるので、
 * `aichat.local` が 127.0.0.1 に解決されても対象外になる。
 * つまり `http://aichat.local:5173` ではマイクが使えない。
 *
 * dev:lan は自己署名の証明書を使うので、初回はブラウザが警告を出す。
 * 「詳細 → このまま進む」で通せば、以後そのオリジンは HTTPS として
 * 扱われ、マイクも使えるようになる。
 */

// 外に出すかどうか。既定は出さない。
const exposed = process.env.VITE_EXPOSE === "1";

export default defineConfig({
  base: "./",
  plugins: exposed ? [basicSsl()] : [],
  server: {
    host: exposed ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    // `aichat.local` のような mDNS 名で開けるようにする。
    // Vite は既定で知らない Host ヘッダを弾く。
    ...(exposed ? { allowedHosts: true as const } : {}),
    proxy: {
      "/api": {
        // ローカルサーバーは外に出さない。ここから 127.0.0.1 に繋ぐので、
        // 外の端末からは Vite 経由でしか届かない。
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
        // SSE を途中でまとめられないように。
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
          });
        },
      },
    },
  },
  build: {
    // Chromium 固定なので落とす必要が無い。
    target: "es2022",
    outDir: "dist",
  },
});

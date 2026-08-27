/** レスポンスの共通ヘルパー。 */

/**
 * ブラウザからの画面遷移リクエストかどうか。
 *
 * アプリ（URLSession）は Accept に text/html を含めないため、
 * これで「人がブラウザで開いた」場合だけを判別できる。
 */
function prefersHtml(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/**
 * エラー応答。
 *
 * アプリ向けには JSON、ブラウザで直接開かれた場合は素っ気ない HTML を返す。
 * ブラウザに生の JSON が見えると、内部構造を推測する手がかりになるため。
 */
export function errorResponse(
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
  request?: Request,
): Response {
  if (request && prefersHtml(request)) {
    return errorPage(status, extraHeaders);
  }
  return Response.json(
    { error: { message } },
    {
      status,
      headers: { "Cache-Control": "no-store", ...extraHeaders },
    },
  );
}

/**
 * ブラウザ向けのエラーページ。
 *
 * 管理UI の場所や API の構成を伝えないよう、内容は最小限にする。
 * 401/403/404 はいずれも「見つからない」に寄せて、
 * パスの存在有無を推測されないようにする。
 */
export function errorPage(
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const heading = status >= 500 ? "問題が発生しました" : "ページが見つかりません";
  const body = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; background: #f6f6f7; color: #1a1a1a;
  }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 .4rem; }
  p { color: #777; font-size: .85rem; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #161618; color: #e8e8ea; }
    p { color: #999; }
  }
</style>
</head>
<body><main><h1>${heading}</h1><p>${status}</p></main></body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...extraHeaders,
    },
  });
}

/** HTML を返す（管理UI用）。 */
export function htmlResponse(
  html: string,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(html, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // 管理UIは自前の HTML/CSS のみ。外部リソースは一切読み込まない。
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      // no-referrer にすると Chrome がフォーム送信時に Origin: null を送るため、
      // CSRF 検証（同一オリジン判定）が通らなくなる。
      // same-origin なら外部への参照元漏洩は防ぎつつ Origin が維持される。
      "Referrer-Policy": "same-origin",
      ...init?.headers,
    },
  });
}

export function redirect(location: string, extraHeaders?: Record<string, string>): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** HTML への値の埋め込みは必ずこれを通す。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

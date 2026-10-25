// Zdalny konektor MCP na Vercelu: te same narzędzia co server.mjs, przez HTTP (bezstanowo).
// Adres dla claude.ai: https://<domena>/mcp/<MCP_TOKEN>. Bez poprawnego tokenu każda odpowiedź to 404.
// Zmienne środowiskowe w Vercelu: LIBRUS_LOGIN, LIBRUS_HASLO, MCP_TOKEN (min. 32 znaki).
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/tools.mjs";

const MIN_TOKEN_LENGTH = 32;
const digest = (text) => createHash("sha256").update(text).digest();

function requestToken(req, url) {
  // ?token= przekazuje vercel.json; nagłówek i /mcp/<token> zostają na wypadek innego klienta lub routingu.
  const auth = String(req.headers.authorization || "");
  const parts = url.pathname.split("/").filter(Boolean);
  return url.searchParams.get("token") || (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "") ||
    (parts.length >= 2 && parts.at(-2) === "mcp" ? parts.at(-1) : "");
}

function send(res, status, body) {
  const json = typeof body === "object";
  res.statusCode = status;
  res.setHeader("content-type", json ? "application/json" : "text/plain; charset=utf-8");
  res.end(json ? JSON.stringify(body) : body);
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const expected = (process.env.MCP_TOKEN || "").trim();
  if (url.searchParams.get("health") === "1") {
    send(res, 200, {
      ok: true,
      mcp_token_ok: expected.length >= MIN_TOKEN_LENGTH,
      librus_login_set: Boolean((process.env.LIBRUS_LOGIN || "").trim()),
      librus_haslo_set: Boolean((process.env.LIBRUS_HASLO || "").trim()),
    });
    return;
  }
  const token = requestToken(req, url);
  if (expected.length < MIN_TOKEN_LENGTH || !timingSafeEqual(digest(token), digest(expected))) {
    send(res, 404, "Not Found");
    return;
  }
  // Serverless: każde zapytanie ma własny, bezstanowy serwer MCP; sesja Librusa i cache danych
  // żyją w module src/librus.mjs, dopóki instancja funkcji jest ciepła.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

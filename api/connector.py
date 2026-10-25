"""Zdalny konektor MCP na Vercelu: te same narzędzia co librus_mcp.py, przez HTTP.

Adres dla claude.ai: https://<domena>/mcp/<MCP_TOKEN>. Bez poprawnego tokenu każda odpowiedź to 404.
Zmienne środowiskowe w Vercelu: LIBRUS_LOGIN, LIBRUS_HASLO, MCP_TOKEN (min. 32 znaki).
"""
from __future__ import annotations

import hmac
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import librus_mcp  # noqa: E402
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import Mount  # noqa: E402

MIN_TOKEN_LENGTH = 32


def request_token(scope: dict) -> str:
    """Token z ?token= (tak przekazuje go vercel.json), z nagłówka Authorization albo z /mcp/<token>."""
    query = parse_qs(scope.get("query_string", b"").decode())
    if query.get("token"):
        return query["token"][0]
    auth = dict(scope.get("headers") or []).get(b"authorization", b"").decode()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    parts = [p for p in scope.get("path", "").split("/") if p]
    return parts[-1] if len(parts) >= 2 and parts[-2] == "mcp" else ""


async def respond(send, status: int, body: dict | str) -> None:
    data = json.dumps(body).encode() if isinstance(body, dict) else body.encode()
    content_type = b"application/json" if isinstance(body, dict) else b"text/plain; charset=utf-8"
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", content_type)]})
    await send({"type": "http.response.body", "body": data})


async def handler(scope, receive, send) -> None:
    expected = os.environ.get("MCP_TOKEN", "").strip()
    if "health=1" in scope.get("query_string", b"").decode():
        await respond(send, 200, {
            "ok": True,
            "mcp_token_ok": len(expected) >= MIN_TOKEN_LENGTH,
            "librus_login_set": bool(os.environ.get("LIBRUS_LOGIN", "").strip()),
            "librus_haslo_set": bool(os.environ.get("LIBRUS_HASLO", "").strip()),
        })
        return
    token = request_token(scope)
    if len(expected) < MIN_TOKEN_LENGTH or not hmac.compare_digest(token.encode(), expected.encode()):
        await respond(send, 404, "Not Found")
        return

    # Serverless: każde zapytanie dostaje własną, bezstanową sesję MCP (bez polegania na lifespan Vercela).
    # Sesja Librusa i cache żyją dalej w librus_mcp.lib, dopóki instancja funkcji jest ciepła.
    app = librus_mcp.mcp.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    async with app.router.lifespan_context(app):
        await app({**scope, "path": "/mcp", "raw_path": b"/mcp", "root_path": ""}, receive, send)


app = Starlette(routes=[Mount("/", app=handler)])

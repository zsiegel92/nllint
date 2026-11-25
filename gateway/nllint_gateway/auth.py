import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from hashlib import sha256
from hmac import compare_digest, digest
from secrets import token_urlsafe
from time import time
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

bearer = HTTPBearer(auto_error=False)
session_router = APIRouter(prefix="/api/session")
SESSION = "nllint_session"
OAUTH_STATE = "nllint_github_state"
CALLBACK = "/api/session/github/callback"
SESSION_SECONDS = 12 * 60 * 60


def digest_key(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def mint_key() -> str:
    return f"nllint_{token_urlsafe(32)}"


async def client_key(
    request: Request, auth: HTTPAuthorizationCredentials | None = Depends(bearer)
) -> int:
    if (
        auth is not None
        and auth.credentials.startswith("nllint_")
        and len(auth.credentials) == 50
    ):
        row = await request.app.state.db.lookup_key(digest_key(auth.credentials))
        if row and request.app.state.settings.allows(row["user_id"]):
            request.state.user_id = row["user_id"]
            return row["key_id"]
    raise HTTPException(401, "Valid gateway API key required")


def sign(value: str, audience: str, request: Request) -> str:
    key = request.app.state.settings.nllint_session_secret.get_secret_value()
    return digest(key.encode(), f"{audience}:{value}".encode(), "sha256").hex()


def pack(claims, audience: str, request: Request) -> str:
    value = urlsafe_b64encode(json.dumps(claims).encode()).decode()
    return f"{value}.{sign(value, audience, request)}"


def unpack(payload: str, audience: str, request: Request):
    if len(payload) > 4096 or "." not in payload:
        return None
    value, mac = payload.rsplit(".", 1)
    if not compare_digest(mac.encode(), sign(value, audience, request).encode()):
        return None
    claims = json.loads(urlsafe_b64decode(value))
    return claims if claims["exp"] > time() else None


async def operator(
    request: Request, auth: HTTPAuthorizationCredentials | None = Depends(bearer)
):
    settings = request.app.state.settings
    if (
        not settings.oauth_enabled
        and settings.nllint_admin_token
        and auth is not None
        and compare_digest(
            auth.credentials.encode(),
            settings.nllint_admin_token.get_secret_value().encode(),
        )
    ):
        await request.app.state.db.register(0)
        request.state.user_id = 0
        return 0
    session = unpack(request.cookies.get(SESSION, ""), "session", request)
    if session is not None and settings.allows(session["id"]):
        if (
            request.method not in {"GET", "HEAD"}
            and request.headers.get("X-NLLint-UI") != "1"
        ):
            raise HTTPException(403, "Missing control-plane header")
        request.state.user_id = session["id"]
        return session["id"]
    raise HTTPException(401, "Sign in required")


def cookie(response, request, name, value, max_age, path):
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        httponly=True,
        secure=request.app.state.settings.nllint_app_url.startswith("https://"),
        samesite="lax",
        path=path,
    )


async def issue_session(request, response, user_id):
    await request.app.state.db.register(user_id)
    claims = {"id": user_id, "exp": int(time()) + SESSION_SECONDS}
    cookie(
        response,
        request,
        SESSION,
        pack(claims, "session", request),
        SESSION_SECONDS,
        "/api",
    )


class Login(BaseModel):
    token: str = Field(max_length=4096)


@session_router.get("/method")
async def method(request: Request):
    return {"github": request.app.state.settings.oauth_enabled}


@session_router.get("")
async def session_status(
    request: Request, auth: HTTPAuthorizationCredentials | None = Depends(bearer)
):
    try:
        user_id = await operator(request, auth)
    except HTTPException as error:
        if error.status_code != 401:
            raise
        return {"authenticated": False}
    return {"authenticated": True, "user_id": str(user_id)}


@session_router.post("", status_code=204)
async def login(body: Login, request: Request, response: Response):
    settings = request.app.state.settings
    if (
        settings.oauth_enabled
        or settings.nllint_admin_token is None
        or request.headers.get("X-NLLint-UI") != "1"
        or not compare_digest(
            body.token.encode(), settings.nllint_admin_token.get_secret_value().encode()
        )
    ):
        raise HTTPException(401, "Invalid local development token")
    await issue_session(request, response, 0)


@session_router.delete("", status_code=204)
async def logout(request: Request, response: Response):
    if request.headers.get("X-NLLint-UI") != "1":
        raise HTTPException(403, "Missing control-plane header")
    response.delete_cookie(SESSION, path="/api")


@session_router.get("/github/start", include_in_schema=False)
async def github_start(request: Request):
    settings = request.app.state.settings
    if not settings.oauth_enabled:
        raise HTTPException(404, "GitHub sign-in is disabled")
    destination = request.query_params.get("next", "/")
    if (
        (destination != "/" and not destination.startswith("/?"))
        or "\\" in destination
        or any(ord(char) < 32 for char in destination)
    ):
        destination = "/"
    callback_host = urlsplit(settings.nllint_app_url).hostname
    if (
        callback_host in {"127.0.0.1", "localhost", "::1"}
        and request.url.hostname != callback_host
    ):
        start_url = settings.nllint_app_url + "/api/session/github/start"
        return RedirectResponse(
            f"{start_url}?{urlencode({'next': destination})}", status_code=303
        )
    nonce, verifier = token_urlsafe(32), token_urlsafe(32)
    challenge = (
        urlsafe_b64encode(sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    params = {
        "client_id": settings.github_client_id,
        "redirect_uri": settings.nllint_app_url + CALLBACK,
        "state": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(
        "https://github.com/login/oauth/authorize?" + urlencode(params), status_code=303
    )
    claims = {
        "nonce": nonce,
        "verifier": verifier,
        "destination": destination,
        "exp": int(time()) + 600,
    }
    cookie(
        response, request, OAUTH_STATE, pack(claims, "oauth", request), 600, CALLBACK
    )
    return response


@session_router.get("/github/callback", include_in_schema=False)
async def github_callback(request: Request, code: str = "", state: str = ""):
    settings = request.app.state.settings
    if not settings.oauth_enabled:
        raise HTTPException(404, "GitHub sign-in is disabled")
    if not code or len(code) > 2048:
        raise HTTPException(
            401, "GitHub did not return an authorization code. Start sign-in again."
        )
    claims = unpack(request.cookies.get(OAUTH_STATE, ""), "oauth", request)
    if not claims:
        raise HTTPException(
            401,
            "The sign-in cookie is missing or expired. Start sign-in again in the same browser.",
        )
    if not compare_digest(state.encode(), claims["nonce"].encode()):
        raise HTTPException(
            401, "This sign-in attempt has been superseded. Start sign-in again."
        )
    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as http:
            token = (
                (
                    await http.post(
                        "https://github.com/login/oauth/access_token",
                        data={
                            "client_id": settings.github_client_id,
                            "client_secret": settings.github_client_secret.get_secret_value(),
                            "code": code,
                            "redirect_uri": settings.nllint_app_url + CALLBACK,
                            "code_verifier": claims["verifier"],
                        },
                        headers={"Accept": "application/json"},
                    )
                )
                .raise_for_status()
                .json()["access_token"]
            )
            profile = (
                (
                    await http.get(
                        "https://api.github.com/user",
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Accept": "application/vnd.github+json",
                        },
                    )
                )
                .raise_for_status()
                .json()
            )
            user_id = int(profile["id"])
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(502, "GitHub sign-in failed") from error
    if not settings.allows(user_id):
        raise HTTPException(403, "This GitHub account is outside the gateway allowlist")
    destination = (settings.nllint_dev_ui_url or "") + claims["destination"]
    response = RedirectResponse(destination, status_code=303)
    response.delete_cookie(OAUTH_STATE, path=CALLBACK)
    await issue_session(request, response, user_id)
    return response

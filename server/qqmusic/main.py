"""小手机 QQ 音乐后端（单用户版，部署到 Render / 任意 Docker 即可）。

只需要一个环境变量：
  ACCESS_KEY   必填，自己随便设一串长密码；App 里「我的QQ」填同一串

接口（全部在 /api/music/ 下，请求头带 X-Access-Key）：
  GET  health           健康检查
  GET  status           {connected}
  POST login/start      {qr}
  GET  login/status     {state}
  GET  search?q=&num=   {songs}
  GET  playlists        {playlists}
  GET  playlist?id=&page=&num=  {songs, hasMore}
  POST song {mid,mediaMid,type} {url, direct}
  GET  lyric?mid=       {lrc, trans}
  GET  stream/{token}   音频转发（备用）
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from qqmusic_api import Client, Credential
from qqmusic_api.models.login import QRLoginType
from qqmusic_api.modules.login_utils import QRCodeLoginSession
from qqmusic_api.modules.search import SearchType
from qqmusic_api.modules.song import SongFileInfo, SongFileType

ACCESS_KEY = os.environ.get("ACCESS_KEY", "").strip()
if not ACCESS_KEY:
    raise SystemExit("请先设置环境变量 ACCESS_KEY")

DATA = Path(os.environ.get("DATA_DIR", "/data"))
DATA.mkdir(parents=True, exist_ok=True)
CRED_FILE = DATA / "credential.json"
DEVICE_FILE = DATA / "device.json"

SECRET = hashlib.sha256(ACCESS_KEY.encode()).digest()
QUALITIES = (SongFileType.MP3_320, SongFileType.MP3_128, SongFileType.ACC_96)

state = {
    "client": None,
    "cred": None,
    "login_task": None,
    "login_state": "idle",
    "login_qr": "",
    "login_err": "",
    "last_check": 0.0,
}
URL_CACHE = {}
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")


def dump(obj):
    try:
        return obj.model_dump()
    except Exception:
        return obj


def save_cred(cred):
    fd = os.open(CRED_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(cred.model_dump(), handle)


def load_cred():
    if not CRED_FILE.exists():
        return None
    try:
        return Credential.model_validate(json.loads(CRED_FILE.read_text(encoding="utf-8")))
    except Exception:
        return None


async def close_client():
    client = state["client"]
    if client is not None:
        try:
            await client.__aexit__(None, None, None)
        except Exception:
            pass
    state["client"] = None


async def open_client(cred):
    await close_client()
    client = Client(credential=cred, device_path=str(DEVICE_FILE))
    await client.__aenter__()
    state["client"] = client
    state["cred"] = cred


async def ensure_fresh():
    client = state["client"]
    if client is None or time.time() - state["last_check"] < 1800:
        return
    state["last_check"] = time.time()
    try:
        if await client.login.check_expired():
            fresh = await client.login.refresh_credential()
            save_cred(fresh)
            await open_client(fresh)
    except Exception as error:
        print("refresh failed:", type(error).__name__)


@asynccontextmanager
async def lifespan(_app):
    cred = load_cred()
    if cred:
        try:
            await open_client(cred)
            await ensure_fresh()
            state["login_state"] = "connected"
        except Exception as error:
            print("restore login failed:", type(error).__name__)
    yield
    await close_client()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=600,
)


def auth(x_access_key: str = Header(default="")):
    if not hmac.compare_digest(x_access_key, ACCESS_KEY):
        raise HTTPException(401, "bad access key")
    return True


async def need():
    if state["client"] is None:
        raise HTTPException(401, "not_logged_in")
    await ensure_fresh()
    client = state["client"]
    if client is None:
        raise HTTPException(401, "not_logged_in")
    return client


def norm_song(song):
    song = song or {}
    singers = song.get("singer") or []
    album = song.get("album") or {}
    file_info = song.get("file") or {}
    pay = song.get("pay") or {}
    album_mid = album.get("mid") or str(album.get("pmid", "")).split("_")[0]
    return {
        "mid": song.get("mid", ""),
        "id": song.get("id", 0),
        "title": song.get("title") or song.get("name", ""),
        "artist": "、".join((x.get("name") or x.get("title") or "") for x in singers),
        "album": album.get("title") or album.get("name", ""),
        "art": f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{album_mid}.jpg" if album_mid else "",
        "duration": song.get("interval", 0) or 0,
        "type": song.get("type", 0) or 0,
        "mediaMid": file_info.get("media_mid", "") or "",
        "vip": bool(pay.get("pay_play") or pay.get("pay_month")),
    }


def find_songs(obj):
    out = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("mid") and (node.get("title") or node.get("name")) and "singer" in node:
                out.append(node)
                return
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(obj)
    return out


@app.get("/api/music/health")
async def health():
    return {"ok": True}


@app.get("/api/music/status")
async def status(_: bool = Depends(auth)):
    return {"connected": state["client"] is not None}


async def login_job():
    try:
        async with Client(device_path=str(DEVICE_FILE)) as client:
            session = QRCodeLoginSession(client.login, QRLoginType.MOBILE, timeout_seconds=180)
            qr = await session.get_qrcode()
            state["login_qr"] = "data:image/png;base64," + base64.b64encode(qr.data).decode()
            state["login_state"] = "waiting"
            cred = await session.wait_qrcode_login()
            save_cred(cred)
        await open_client(cred)
        state["login_state"] = "connected"
    except asyncio.CancelledError:
        state["login_state"] = "idle"
        raise
    except Exception as error:
        state["login_state"] = "error"
        state["login_err"] = type(error).__name__


@app.post("/api/music/login/start")
async def login_start(_: bool = Depends(auth)):
    task = state["login_task"]
    if task and not task.done():
        task.cancel()
    state["login_state"], state["login_qr"], state["login_err"] = "starting", "", ""
    state["login_task"] = asyncio.create_task(login_job())
    for _ in range(80):
        if state["login_qr"] or state["login_state"] == "error":
            break
        await asyncio.sleep(0.25)
    if not state["login_qr"]:
        raise HTTPException(502, "获取二维码失败：" + (state["login_err"] or "超时"))
    return {"qr": state["login_qr"]}


@app.get("/api/music/login/status")
async def login_status(_: bool = Depends(auth)):
    current = "connected" if state["client"] is not None and state["login_state"] != "waiting" else state["login_state"]
    return {"state": current, "error": state["login_err"]}


@app.get("/api/music/playlists")
async def playlists(_: bool = Depends(auth)):
    client = await need()
    cred = state["cred"]
    result = await client.user.get_created_songlist(int(getattr(cred, "musicid", 0)))
    items = []
    for playlist in getattr(result, "playlists", []):
        data = dump(playlist)
        items.append({
            "id": data.get("id"),
            "title": data.get("title") or data.get("name") or "",
            "songnum": data.get("songnum", 0),
            "cover": data.get("picurl") or data.get("cover") or "",
        })
    return {"playlists": items}


@app.get("/api/music/playlist")
async def playlist(id: int, page: int = 1, num: int = 30, _: bool = Depends(auth)):
    client = await need()
    result = dump(await client.songlist.get_detail(id, num=num, page=page))
    info = result.get("info") or {}
    songs = [norm_song(item) for item in (result.get("songs") or [])]
    total = int(info.get("songnum", 0) or 0)
    return {
        "title": info.get("title", ""),
        "cover": info.get("picurl", ""),
        "songs": songs,
        "hasMore": bool(songs) and page * num < total,
    }


@app.get("/api/music/search")
async def search(q: str, page: int = 1, num: int = 20, _: bool = Depends(auth)):
    client = await need()
    result = await client.search.search_by_type(q, SearchType.SONG, num=num, page=page)
    seen, songs = set(), []
    for raw in find_songs(dump(result)):
        song = norm_song(raw)
        if song["mid"] and song["mid"] not in seen:
            seen.add(song["mid"])
            songs.append(song)
    return {"songs": songs, "page": page}


@app.get("/api/music/lyric")
async def lyric(mid: str, _: bool = Depends(auth)):
    client = await need()
    data = dump(await client.lyric.get_lyric(mid, trans=True))
    return {"lrc": data.get("lyric", ""), "trans": data.get("trans", "")}


async def upstream_url(mid, media_mid=None, song_type=0):
    client = await need()
    if not media_mid:
        detail = await client.song.get_detail(mid)
        track = getattr(detail, "track", None)
        if track is None:
            tracks = getattr(detail, "tracks", None)
            track = tracks[0] if tracks else None
        if track is None:
            raise HTTPException(404, "song not found")
        media_mid = getattr(getattr(track, "file", None), "media_mid", "") or None
        song_type = getattr(track, "type", 0)
    info = SongFileInfo(mid=mid, media_mid=media_mid or None, song_type=song_type or 0)
    for quality in QUALITIES:
        result = await client.song.get_song_urls(
            file_info=[info], file_type=quality, credential=state["cred"],
        )
        for row in getattr(result, "data", []):
            purl = getattr(row, "purl", "")
            if purl and getattr(row, "result", 0) == 0:
                if purl.startswith("http"):
                    return purl, quality.name
                sip = getattr(result, "sip", None) or []
                base = str(sip[0]) if sip else "https://isure.stream.qqmusic.qq.com/"
                return base.rstrip("/") + "/" + purl.lstrip("/"), quality.name
    raise HTTPException(403, "没有可播放的地址（可能需要会员，或该歌曲不可用）")


def make_token(mid, media_mid, song_type, ttl=6 * 3600):
    payload = json.dumps({"m": mid, "mm": media_mid, "t": song_type, "e": int(time.time()) + ttl},
                         separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    signature = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    return body + "." + signature


def read_token(token):
    try:
        body, signature = token.split(".", 1)
        good = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(signature, good):
            raise ValueError
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if data["e"] < time.time():
            raise ValueError
        return data
    except Exception:
        raise HTTPException(403, "bad or expired token")


class SongRequest(BaseModel):
    mid: str
    mediaMid: str = ""
    type: int = 0


def https_variants(url):
    rest = url.split("://", 1)[1] if "://" in url else url
    return ["https://" + rest, "http://" + rest]


@app.post("/api/music/song")
async def song(payload: SongRequest, _: bool = Depends(auth)):
    url, quality = await upstream_url(payload.mid, payload.mediaMid or None, payload.type)
    token = make_token(payload.mid, payload.mediaMid, payload.type)
    return {
        "url": f"/api/music/stream/{token}",
        "direct": https_variants(url)[0],
        "quality": quality,
    }


@app.get("/api/music/stream/{token}")
async def stream(token: str, request: Request):
    data = read_token(token)
    now = time.time()
    cached = URL_CACHE.get(token)
    if cached and cached[1] > now:
        url = cached[0]
    else:
        url, _ = await upstream_url(data["m"], data.get("mm") or None, data.get("t", 0))
        URL_CACHE[token] = (url, now + 600)
        for key in [k for k, v in URL_CACHE.items() if v[1] < now]:
            URL_CACHE.pop(key, None)
    headers = {"User-Agent": UA, "Referer": "https://y.qq.com/", "Origin": "https://y.qq.com"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header
    last_error = None
    for candidate in https_variants(url):
        try:
            client = httpx.AsyncClient(timeout=httpx.Timeout(40, connect=15), follow_redirects=True)
            upstream = await client.send(client.build_request("GET", candidate, headers=headers), stream=True)
            if upstream.status_code >= 400:
                await upstream.aclose()
                await client.aclose()
                last_error = f"upstream {upstream.status_code}"
                continue
            response_headers = {}
            for key in ("content-type", "content-length", "accept-ranges", "content-range"):
                value = upstream.headers.get(key)
                if value:
                    response_headers[key] = value
            return StreamingResponse(
                upstream.aiter_raw(),
                status_code=upstream.status_code,
                headers=response_headers,
                background=None,
            )
        except Exception as error:
            last_error = type(error).__name__
    raise HTTPException(502, f"音频转发失败：{last_error}")

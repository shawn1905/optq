#!/usr/bin/env python3
"""期权历史行情本地服务 v3（T 型报价 + 双分时）。

数据目录（--data-dir）：
  <标的>/1d/year=YYYY/data.parquet            日线（含 IV/希腊字母）
  <标的>/1m/year=YYYY/YYYYMMDD.parquet        期权分钟（价/量/额，无 oi）
  <标的>/spot_1m/year=YYYY/YYYYMMDD.parquet   标的分钟（ETF 现券，可选）

接口：
  /api/meta  /api/dates  /api/chain  /api/contracts  /api/curve
  /api/intraday?code=&date=&contract=   双分时（标的 + 期权 + ATM IV + 合约 IV）
"""
import argparse
import json
import math
import os
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from scipy.stats import norm

import v3_api

NAS_HOST = os.environ.get("NAS_HOST", "dahongge@100.112.86.77")
NAS_ROOT = os.environ.get("NAS_ROOT", "/home/dahongge/Quant_Database/options/web_opt/parquet")
CACHE_DIR = Path(os.environ.get("OPTQ_CACHE", "/opt/optq/cache"))
CACHE_MAX = int(os.environ.get("OPTQ_CACHE_MAX", 2 * 1024 ** 3))
INDEX_TTL = 600          # 目录索引 10 分钟
TODAY_TTL = 600          # 当天的分日文件 10 分钟（会变）
MISS_TTL = 300           # 不存在的结果缓存 5 分钟

HUIDIAN = "https://cloud.pobo.net.cn:8111/pbfundinfo/v0.0.1/backmanagement"
CTX = ssl._create_unverified_context()
R = 0.045

_lock = threading.Lock()
_df_cache: dict[tuple, tuple[float, object]] = {}
_quote_cache = {}
_miss_cache: dict[str, float] = {}
_index = {"t": 0.0, "files": set()}
_index_lock = threading.Lock()
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", NAS_HOST]
SCP = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6"]


def _remote_index() -> set[str]:
    """NAS 上所有 parquet 的相对路径；10 分钟刷新一次。"""
    with _index_lock:
        if _index["files"] and time.time() - _index["t"] < INDEX_TTL:
            return _index["files"]
    try:
        out = subprocess.run(SSH + [f'find {NAS_ROOT} -name "*.parquet" -printf "%P\\n"'],
                             capture_output=True, text=True, timeout=60)
        files = {x for x in out.stdout.splitlines() if x}
        if files:
            with _index_lock:
                _index.update(t=time.time(), files=files)
    except Exception:
        pass
    return _index["files"]


def _evict():
    total, entries = 0, []
    for p in CACHE_DIR.rglob("*.parquet"):
        try:
            st = p.stat()
            total += st.st_size
            entries.append((st.st_mtime, p, st.st_size))
        except FileNotFoundError:
            continue
    if total <= CACHE_MAX:
        return
    for _, p, sz in sorted(entries):
        try:
            p.unlink()
        except FileNotFoundError:
            continue
        total -= sz
        if total <= CACHE_MAX:
            break


def ensure_local(rel: str):
    """按需把 NAS 上的文件拉到本地缓存；不可达/不存在返回 None。"""
    now = time.time()
    if _miss_cache.get(rel, 0) > now:
        return None
    if rel not in _remote_index():
        _miss_cache[rel] = now + MISS_TTL
        return None

    dst = CACHE_DIR / rel
    today = datetime.now().strftime("%Y%m%d")
    is_hot = rel.split("/")[-1][:8] >= today or datetime.now().strftime("%Y%m") in rel
    if dst.exists():
        age = now - dst.stat().st_mtime
        if not is_hot or age < TODAY_TTL:
            return dst

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    try:                                     # 用 ssh cat 取文件（NAS 的 SFTP 不可用）
        with open(tmp, "wb") as fh:
            r = subprocess.run(SSH + [f'cat "{NAS_ROOT}/{rel}"'],
                               stdout=fh, stderr=subprocess.DEVNULL, timeout=180)
        ok = r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0
    except Exception:
        ok = False
    if not ok:
        tmp.unlink(missing_ok=True)
        _miss_cache[rel] = now + MISS_TTL
        return None
    os.replace(tmp, dst)
    _evict()
    return dst


def load_parent(kind: str, code: str, year: int):
    """只缓存日线（1d）；分钟按日文件读取，不在此处理。"""
    if kind != "1d":
        return None
    rel = f"{code}/1d/year={year}/data.parquet"
    path = ensure_local(rel)
    if path is None:
        return None
    mtime = path.stat().st_mtime
    key = (kind, code, year)
    with _lock:
        hit = _df_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    df = pq.read_table(path).to_pandas()
    with _lock:
        _df_cache[key] = (mtime, df)
    return df


def load_day_minute(code: str, kind: str, date: int):
    rel = f"{code}/{kind}/year={date // 10000}/{date}.parquet"
    path = ensure_local(rel)
    if path is None:
        return None
    return pq.read_table(path).to_pandas()


def last_minute_date(code: str, kind: str = "spot_1m"):
    prefix = f"{code}/{kind}/"
    days = [int(x.rsplit("/", 1)[-1].split(".")[0]) for x in _remote_index()
            if x.startswith(prefix) and "year=" in x]
    return max(days) if days else None


def years(code: str) -> list[int]:
    prefix = f"{code}/1d/year="
    ys = {int(x[len(prefix):].split("/")[0]) for x in _remote_index()
          if x.startswith(prefix) and x.endswith("/data.parquet")}
    return sorted(ys)


def all_dates(code: str) -> list[int]:
    """日期列表直接取自分日文件名（1m / spot_1m），不用读 parquet，成本为零。"""
    days = set()
    for kind in ("1m", "spot_1m"):
        prefix = f"{code}/{kind}/year="
        for x in _remote_index():
            if x.startswith(prefix) and x.endswith(".parquet"):
                stem = x.rsplit("/", 1)[-1].split(".")[0]
                if stem.isdigit():
                    days.add(int(stem))
    if not days:                       # 兜底：读日线
        for y in years(code):
            df = load_parent("1d", code, y)
            if df is not None:
                days |= {int(d) for d in df.date.unique()}
    return sorted(days)


def underlying_quote(code: str, date: int):
    """标的当日行情：优先本地 spot_1m，其次迅投接口（网络不可靠，仅兜底）。"""
    key = (code, date)
    with _lock:
        if key in _quote_cache:
            return _quote_cache[key]

    hit = None
    df = load_day_minute(code, "spot_1m", date)
    if df is not None and len(df):
        d = df[(df.close > 0)]
        if len(d):
            close = float(d.close.iloc[-1])
            high = float(d.high.max())
            low = float(d.low[d.low > 0].min())
            vol = float(d.vol.sum())
            prev = None
            for k in range(1, 12):
                pday = int((datetime.strptime(str(date), "%Y%m%d") - timedelta(days=k)).strftime("%Y%m%d"))
                pdf = load_day_minute(code, "spot_1m", pday)
                if pdf is None or not len(pdf):
                    continue
                p = pdf[pdf.close > 0]
                if len(p):
                    prev = float(p.close.iloc[-1])
                    break
            chg = (close / prev - 1) * 100 if prev else 0.0
            hit = {"targetcode": code, "targetname": code, "date": date, "close": close,
                   "high": high, "low": low, "volume": vol, "change": chg,
                   "pre_close": prev}
    if hit is None:
        iso = f"{str(date)[:4]}-{str(date)[4:6]}-{str(date)[6:]}"
        try:
            req = urllib.request.Request(f"{HUIDIAN}/queryContractInstrument?date={iso}")
            with urllib.request.urlopen(req, timeout=8, context=CTX) as r:
                data = json.load(r).get("data") or []
            hit = next((x for x in data if x.get("targetcode") == code), None)
        except Exception:
            hit = None

    with _lock:
        _quote_cache[key] = hit
    return hit


_SQRT2 = math.sqrt(2.0)


def _cdf(x: float) -> float:
    """标准正态 CDF：用 math.erf，比 scipy 标量调用快一个数量级。"""
    return 0.5 * (1.0 + math.erf(x / _SQRT2))


def iv_vec(S, K, T, is_call, price):
    lo, hi = 1e-4, 3.0
    sqT = math.sqrt(T)
    lnSK = math.log(S / K)
    dk = K * math.exp(-R * T)
    for _ in range(48):
        mid = (lo + hi) / 2
        d1 = (lnSK + (R + 0.5 * mid * mid) * T) / (mid * sqT)
        d2 = d1 - mid * sqT
        if is_call:
            px = S * _cdf(d1) - dk * _cdf(d2)
        else:
            px = dk * _cdf(-d2) - S * _cdf(-d1)
        if px > price:
            hi = mid
        else:
            lo = mid
    return float((lo + hi) / 2)


def normalize_minute(df: pd.DataFrame) -> pd.DataFrame:
    """统一成 t/open/high/low/close/vol/amount[/oi] 且按时间排序。"""
    d = df.copy()
    if "trade_time" in d.columns:
        d["t"] = d["trade_time"].astype(str).str[11:16]
    else:
        d["t"] = d["minute"].astype(str)
    if "vol" not in d.columns:
        d["vol"] = d.get("volume", 0)
    out = d[["t", "open", "high", "low", "close", "vol", "amount"]].copy()
    if "oi" in d.columns:
        out["oi"] = d["oi"]
    return out.sort_values("t").reset_index(drop=True)


def carry_forward(bars):
    """无成交分钟沿用上一笔成交价，画成平线，避免分时图出现断点。"""
    last = None
    for b in bars:
        c = b.get("close")
        if c is not None and c > 0:
            last = c
        elif last is not None:
            b["open"] = b["high"] = b["low"] = b["close"] = last
            b["vol"] = 0
            b["amount"] = 0
    return bars


def clean(o):
    """把 NaN/Inf 转成 null，避免 JS JSON.parse 失败。"""
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


class Handler(BaseHTTPRequestHandler):
    server_version = "optq/3.0"

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200, ctype="application/json; charset=utf-8", cache="no-store"):
        body = obj if isinstance(obj, bytes) else json.dumps(clean(obj), ensure_ascii=False,
                                                             default=float, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _static(self, folder: str, rel: str):
        base = (Path(__file__).parent / folder).resolve()
        f = (base / (rel.lstrip("/") or "index.html")).resolve()
        if (f == base or base in f.parents) and f.is_file():
            ctype = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                     ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                     ".svg": "image/svg+xml", ".png": "image/png",
                     ".woff2": "font/woff2"}.get(f.suffix, "application/octet-stream")
            cache = "public, max-age=86400" if f.suffix == ".woff2" else "no-store"
            return self._send(f.read_bytes(), ctype=ctype, cache=cache)
        return self._send({"error": "not found"}, 404)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path in ("/v2", "/v3"):
            self.send_response(302)
            self.send_header("Location", u.path.lstrip("/") + "/" + (f"?{u.query}" if u.query else ""))
            return self.end_headers()
        if u.path.startswith("/v3/api/v1/"):
            code, payload = v3_api.handle(u.path[len("/v3/api/v1/"):].strip("/"), q)
            return self._send(payload, code=code)
        if u.path.startswith("/v3/"):
            return self._static("v3", u.path[len("/v3/"):])
        if u.path.startswith("/v2"):
            return self._static("v2", u.path[len("/v2"):])
        if u.path in ("/", "/index.html"):
            return self._send((Path(__file__).parent / "index.html").read_bytes(),
                              ctype="text/html; charset=utf-8")
        if u.path == "/api/meta":
            codes = sorted({x.split("/")[0] for x in _remote_index()
                            if x.endswith("/data.parquet") and "/1d/" in x})
            out = []
            for c in codes:
                ds = all_dates(c)
                out.append({"code": c, "dates": len(ds), "last": ds[-1] if ds else None,
                            "last1m": last_minute_date(c) or last_minute_date(c, "1m")})
            return self._send({"codes": out})
        if u.path == "/api/dates":
            return self._send({"dates": all_dates(q.get("code", "510050"))})
        if u.path == "/api/chain":
            code = q.get("code", "510050")
            date = int(q["date"])
            df = load_parent("1d", code, date // 10000)
            if df is None:
                return self._send({"error": "no data"}, 404)
            sub = df[df.date == date]
            rows = sub.sort_values(["expiry", "strike", "call_put"]).to_dict("records")
            months = sorted({int(x) for x in sub.s_month.unique()})
            return self._send({"code": code, "date": date, "quote": underlying_quote(code, date),
                               "months": months, "rows": rows})
        if u.path == "/api/curve":
            code = q.get("code", "510050")
            date = int(q["date"]) if q.get("date") else all_dates(code)[-1]
            df = load_parent("1d", code, date // 10000)
            sub = df[df.date == date]
            if q.get("month"):
                sub = sub[sub.s_month == int(q["month"])]
            out = []
            for strike, g in sub.groupby("strike"):
                c = g[g.call_put == "C"]; p = g[g.call_put == "P"]
                out.append({"strike": float(strike),
                            "call_oi": int(c.oi_web.sum()) if len(c) else 0,
                            "put_oi": int(p.oi_web.sum()) if len(p) else 0,
                            "call_vol": int(c.volume.sum()) if len(c) else 0,
                            "put_vol": int(p.volume.sum()) if len(p) else 0})
            return self._send({"code": code, "date": date,
                               "series": sorted(out, key=lambda x: x["strike"])})
        if u.path == "/api/intraday":
            return self._intraday(q)
        return self._send({"error": "not found"}, 404)

    def _intraday(self, q):
        code = q.get("code", "510050")
        date = int(q["date"])
        contract = q.get("contract", "").split(".")[0]
        month = int(q["month"]) if q.get("month") else None

        chain = load_parent("1d", code, date // 10000)
        if chain is None:
            return self._send({"error": "no data"}, 404)
        day = chain[chain.date == date].copy()
        day["c8"] = day.code.str[:8]

        # 标的分钟
        spot_df = load_day_minute(code, "spot_1m", date)
        spot = {"mode": "none", "bars": []}
        prev_close = None
        if spot_df is not None and len(spot_df):
            s = normalize_minute(spot_df)
            spot = {"mode": "minute", "bars": carry_forward(
                s[["t", "open", "high", "low", "close", "vol", "amount"]].to_dict("records"))}
            q0 = underlying_quote(code, date)
            if q0 and q0.get("close"):
                prev_close = None  # 由日线/接口另给

        # 期权分钟
        opt = {"contract": contract, "bars": [], "meta": None}
        if contract:
            odf = load_day_minute(code, "1m", date)
            if odf is not None:
                sel = odf[odf.code.astype(str).str[:8] == contract]
                if len(sel):
                    o = normalize_minute(sel)
                    meta = day[day.c8 == contract]
                    if len(meta):
                        r = meta.iloc[0]
                        opt["meta"] = {"name": r["name"], "strike": float(r.strike),
                                       "expiry": int(r.expiry), "call_put": r.call_put,
                                       "close": float(r.close), "settle": float(r.settle),
                                       "oi": int(r.oi_web) if pd.notna(r.oi_web) else None}
                    bars = o.to_dict("records")
                    # 逐分钟 IV（需要标的分钟价）
                    if spot["mode"] == "minute" and opt["meta"]:
                        smap = {b["t"]: b["close"] for b in spot["bars"]}
                        T = ((datetime.strptime(str(opt["meta"]["expiry"]), "%Y%m%d")
                              - datetime.strptime(str(date), "%Y%m%d")).days + 1) / 365
                        if T > 0:
                            for b in bars:
                                S = smap.get(b["t"])
                                k = opt["meta"]["strike"]
                                if S and b.get("close") and float(b["close"]) > 0:
                                    b["iv"] = round(iv_vec(S, k, T, opt["meta"]["call_put"] == "C",
                                                           float(b["close"])), 5)
                    carry_forward(bars)
                    opt["bars"] = bars

        # ATM IV：每分钟取最接近 S 的认购/认沽，各解一次 IV 取均值
        atm_iv = []
        if spot["mode"] == "minute" and opt["meta"]:
            sub = day[(day.s_month == (month or opt["meta"]["expiry"] // 100))]
            expiry = int(opt["meta"]["expiry"])
            T = ((datetime.strptime(str(expiry), "%Y%m%d") - datetime.strptime(str(date), "%Y%m%d")).days + 1) / 365
            o1m = load_day_minute(code, "1m", date)
            if o1m is not None and T > 0 and len(spot["bars"]):
                o1m = o1m.copy()
                o1m["c8"] = o1m.code.astype(str).str[:8]
                # 固定平值档：按当日标的中位价选一次，避免逐分钟换档造成跳变
                s_med = float(np.median([b["close"] for b in spot["bars"]]))
                picks = {}
                for side in ("C", "P"):
                    g = sub[sub.call_put == side]
                    if len(g):
                        k = float(g.iloc[(g.strike - s_med).abs().argsort()[:1]]["strike"].iloc[0])
                        picks[side] = (k, g[g.strike == k].c8.iloc[0])
                series = {}
                for side, (k, c8) in picks.items():
                    rows = o1m[o1m.c8 == c8].set_index("minute")["close"].to_dict()
                    series[side] = {t: (k, float(v)) for t, v in rows.items() if v and float(v) > 0}
                for bar in spot["bars"]:
                    S = bar["close"]
                    ivs = [iv_vec(S, k, T, side == "C", px)
                           for side in ("C", "P") for (k, px) in
                           ([series[side][bar["t"]]] if side in series and bar["t"] in series[side] else [])]
                    atm_iv.append(round(float(np.mean(ivs)), 5) if ivs else None)
        return self._send({"code": code, "date": date, "spot": spot, "prev_close": prev_close,
                           "option": opt, "atm_iv": atm_iv})


def main() -> None:
    global NAS_HOST, NAS_ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--nas-host", default=NAS_HOST)
    ap.add_argument("--nas-root", default=NAS_ROOT)
    args = ap.parse_args()
    NAS_HOST, NAS_ROOT = args.nas_host, args.nas_root
    v3_api.bind(sys.modules[__name__])
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"serving on http://{args.host}:{args.port}  nas={NAS_HOST}:{NAS_ROOT}  cache={CACHE_DIR}", flush=True)

    def warm_up():                      # 预热：把当年的日线拉到本地缓存，避免首个用户等
        year = datetime.now().year
        for c in sorted({x.split("/")[0] for x in _remote_index()
                         if x.endswith("/data.parquet") and "/1d/" in x}):
            try:
                if load_parent("1d", c, year) is not None:
                    print(f"warmed {c}/{year}", flush=True)
            except Exception as e:
                print(f"warm {c} failed: {e}", flush=True)

    threading.Thread(target=warm_up, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()

"""V3 接口（/v3/api/v1/*）：按 V3 前端约定的数据契约输出目录、期权链、分时。

数据全部来自 NAS 的 web 层（经 server.py 的按需缓存读取），本模块只读、不写任何数据：
  catalog   <- _v3/catalog.parquet（NAS 上 build_v3_catalog.py 生成的目录索引）
  chain     <- <标的>/1d（收盘快照）；带 replayAt 时由 <标的>/1m + spot_1m 回放到该分钟
  intraday  <- <标的>/spot_1m（标的）或 <标的>/1m（期权合约）

时间一律输出真实 Unix 时间（秒或毫秒），前端按 Asia/Shanghai 显示。
"""
import bisect
import calendar
import math
import re
import threading
import time
import traceback
from collections import OrderedDict

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

NAMES = {
    "510050": "上证50ETF", "510300": "沪深300ETF", "510500": "中证500ETF",
    "588000": "科创50ETF", "588080": "科创板50ETF",
    "159901": "深证100ETF", "159915": "创业板ETF",
    "159919": "沪深300ETF(深)", "159922": "中证500ETF(深)",
}
CODES = list(NAMES)
CHANNEL = "nas"
ETF_TICK = 0.001
OPT_TICK = 0.0001
IV_FLOOR = 1.5e-4          # 日线里 0.0001 表示求解失败，不当作有效 IV
DAY_CACHE = 8

core = None                # server.py 模块，由 bind() 注入
_lock = threading.Lock()
_meta: dict = {}
_days: "OrderedDict[tuple, pd.DataFrame | None]" = OrderedDict()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def bind(module) -> None:
    global core
    core = module


# ---------- 基础工具 ----------

def _iso(day: int) -> str:
    s = str(int(day))
    return f"{s[:4]}-{s[4:6]}-{s[6:]}"


def _ymd(text) -> int:
    if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ApiError(400, "交易日格式无效")
    return int(text.replace("-", ""))


def _day_base(day: int) -> int:
    """该交易日北京时间 00:00 的 Unix 秒。"""
    return calendar.timegm((day // 10000, day // 100 % 100, day % 100, 0, 0, 0)) - 8 * 3600


def _secs(label: str) -> int:
    return int(label[:2]) * 3600 + int(label[3:5]) * 60


def _num(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _pos(value):
    v = _num(value)
    return v if v is not None and v > 0 else None


def _exchange(code: str) -> str:
    return "SSE" if code.startswith("5") else "SZSE"


def _local(rel: str):
    """取 NAS 文件的本地缓存；NAS 暂不可达时退回已有的旧缓存。"""
    path = core.ensure_local(rel)
    if path is None:
        stale = core.CACHE_DIR / rel
        return stale if stale.exists() else None
    return path


def _meta_tables() -> dict:
    cat_path, con_path = _local("_v3/catalog.parquet"), _local("_v3/contracts.parquet")
    if cat_path is None or con_path is None:
        raise ApiError(503, "目录索引暂不可用，请稍后刷新")
    key = (cat_path.stat().st_mtime, con_path.stat().st_mtime)
    with _lock:
        if _meta.get("key") == key:
            return _meta
    cat = pq.read_table(cat_path).to_pandas()
    con = pq.read_table(con_path).to_pandas()
    days = sorted(int(d) for d in cat.date.unique())
    fresh = {
        "key": key,
        "days": days,
        "by_day": {int(d): g for d, g in cat.groupby("date")},
        "dates": [{"tradingDay": _iso(d), "hasTicks": True, "hasMetadata": True} for d in days],
        "mult": dict(zip(con.c8.astype(str), con.multiplier.astype(int))),
        "tick": dict(zip(con.c8.astype(str), con.tick.astype(float))),
    }
    with _lock:
        _meta.clear()
        _meta.update(fresh)
    return _meta


def _prev_day(day: int):
    days = _meta_tables()["days"]
    i = bisect.bisect_left(days, day)
    return days[i - 1] if i > 0 else None


def _minute(code: str, kind: str, day: int):
    """分日分钟文件，统一成 t/open/high/low/close/vol/amount[/oi][/c8]，按时间排序。"""
    rel = f"{code}/{kind}/year={day // 10000}/{day}.parquet"
    path = _local(rel)
    if path is None:
        return None
    key = (rel, path.stat().st_mtime)
    with _lock:
        if key in _days:
            _days.move_to_end(key)
            return _days[key]
    d = pq.read_table(path).to_pandas()
    d["t"] = (d["trade_time"].astype(str).str[11:16] if "trade_time" in d.columns
              else d["minute"].astype(str).str[:5])
    if "vol" not in d.columns:
        d["vol"] = d["volume"] if "volume" in d.columns else 0
    cols = ["t", "open", "high", "low", "close", "vol", "amount"]
    if "oi" in d.columns:
        cols.append("oi")
    if kind == "1m":
        d["c8"] = d["code"].astype(str).str[:8]
        cols.insert(0, "c8")
        out = d[cols].sort_values(["c8", "t"]).reset_index(drop=True)
    else:
        out = d[cols].sort_values("t").reset_index(drop=True)
    with _lock:
        _days[key] = out
        while len(_days) > DAY_CACHE:
            _days.popitem(last=False)
    return out


def _spot(code: str, day: int):
    d = _minute(code, "spot_1m", day)
    if d is None:
        return None
    d = d[d.close > 0]
    return d if len(d) else None


def _prev_spot_close(code: str, day: int):
    prev = _prev_day(day)
    for _ in range(5):                       # 标的个别日期缺分钟时再往前找
        if prev is None:
            return None
        s = _spot(code, prev)
        if s is not None:
            return float(s.close.iloc[-1])
        prev = _prev_day(prev)
    return None


def _series(series_id):
    m = re.fullmatch(r"(\d{6})-(\d{8})-(\d{1,7})", series_id or "")
    if not m or m.group(1) not in NAMES:
        raise ApiError(400, "期权系列无效")
    return m.group(1), int(m.group(2)), int(m.group(3))


def _series_rows(code: str, day: int, expiry: int, mult: int) -> pd.DataFrame:
    df = core.load_parent("1d", code, day // 10000)
    if df is None:
        raise ApiError(404, "该交易日暂无期权链")
    sub = df[(df.date == day) & (df.expiry == expiry)].copy()
    sub["c8"] = sub.code.astype(str).str[:8]
    mults = _meta_tables()["mult"]
    sub = sub[sub.c8.map(lambda c: mults.get(c, 10000)) == mult]
    if sub.empty:
        raise ApiError(404, "该交易日暂无此期权系列")
    return sub.sort_values(["strike", "call_put", "c8"])


def _prev_closes(code: str, day: int) -> dict:
    prev = _prev_day(day)
    if prev is None:
        return {}
    df = core.load_parent("1d", code, prev // 10000)
    if df is None:
        return {}
    p = df[df.date == prev]
    return {str(c)[:8]: float(v) for c, v in zip(p.code, p.close) if v and v > 0}


def _years_to_expiry(day: int, expiry: int) -> float:
    return ((_day_base(expiry) - _day_base(day)) / 86400 + 1) / 365


# ---------- Black-Scholes ----------

def _analytics(S: float, K: float, T: float, is_call: bool, price: float, stamp: int):
    """由价格反解 IV 并计算希腊字母；单位与日线一致（Vega 每 1% 波动率，Theta 每日）。"""
    empty = {k: {"value": None, "time": None} for k in ("impliedVol", "delta", "gamma", "vega", "theta")}
    if not (S and K and T > 0 and price and price > 0):
        return empty
    r = core.R
    disc = K * math.exp(-r * T)
    bound = max(0.0, S - disc) if is_call else max(0.0, disc - S)
    if price <= bound + 1e-6:
        return empty
    iv = core.iv_vec(S, K, T, is_call, price)
    if not (IV_FLOOR < iv < 2.99):
        return empty
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sq)
    d2 = d1 - iv * sq
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    cdf = core._cdf
    if is_call:
        delta = cdf(d1)
        theta = -(S * pdf * iv) / (2 * sq) - r * disc * cdf(d2)
    else:
        delta = cdf(d1) - 1
        theta = -(S * pdf * iv) / (2 * sq) + r * disc * cdf(-d2)
    values = {"impliedVol": iv, "delta": delta, "gamma": pdf / (S * iv * sq),
              "vega": S * pdf * sq / 100, "theta": theta / 365}
    return {k: {"value": v, "time": stamp} for k, v in values.items()}


# ---------- catalog ----------

def catalog(q: dict) -> dict:
    m = _meta_tables()
    days = m["days"]
    day = _ymd(q["tradingDay"]) if q.get("tradingDay") else days[-1]
    if day not in m["by_day"]:
        i = bisect.bisect_right(days, day) - 1
        day = days[max(i, 0)]
    g = m["by_day"][day]
    series, products = [], []
    for code in CODES:
        s = g[g.code == code].sort_values(["expiry", "n"], ascending=[True, False])
        if s.empty:
            continue
        products.append({"id": code, "name": NAMES[code], "productId": code})
        for r in s.itertuples():
            series.append({"id": f"{code}-{int(r.expiry)}-{int(r.multiplier)}", "productKey": code,
                           "underlyingSymbol": code, "underlyingExchange": _exchange(code),
                           "sourceChannel": CHANNEL, "expiry": _iso(r.expiry),
                           "multiplier": int(r.multiplier), "label": ""})
    return {"tradingDay": _iso(day), "dates": m["dates"], "products": products, "series": series}


# ---------- chain ----------

def _replay_label(day: int, replay_at) -> str:
    try:
        ms = int(replay_at)
    except (TypeError, ValueError):
        raise ApiError(400, "回放时间无效")
    offset = ms // 1000 - _day_base(day)
    if not 0 <= offset < 86400:
        raise ApiError(400, "回放时间不在该交易日内")
    return f"{offset // 3600:02d}:{offset % 3600 // 60:02d}"


def _underlying(code: str, day: int, label=None):
    spot = _spot(code, day)
    if spot is None:
        return None
    s = spot if label is None else spot[spot.t <= label]
    if s.empty:
        return None
    price = float(s.close.iloc[-1])
    prev = _prev_spot_close(code, day)
    lows = s.low[s.low > 0]
    return {"kind": "ETF", "exchange": _exchange(code), "symbol": code, "name": NAMES[code],
            "price": price, "priceSource": "close" if label is None else "last",
            "changePct": (price / prev - 1) * 100 if prev else None,
            "high": float(s.high.max()), "low": float(lows.min()) if len(lows) else None,
            "volume": float(s.vol.sum()),
            "dataTime": (_day_base(day) + _secs(s.t.iloc[-1])) * 1000,
            "sourceChannel": CHANNEL, "priceTick": ETF_TICK, "quality": []}


def _replay_state(code: str, day: int, c8s: set, label: str) -> dict:
    """回放到 label 这一分钟时，各合约的 价/开/高/低/累计量/持仓/行情时间。"""
    opt = _minute(code, "1m", day)
    if opt is None:
        return {}
    o = opt[opt.c8.isin(c8s) & (opt.t <= label)]
    if o.empty:
        return {}
    has_oi = "oi" in o.columns
    state = {}
    for c8, g in o.groupby("c8", sort=False):
        traded = g[g.close > 0]
        if traded.empty:
            continue
        opens, lows = g.open[g.open > 0], g.low[g.low > 0]
        last = traded.iloc[-1]
        state[c8] = {
            "price": float(last.close),
            "open": float(opens.iloc[0]) if len(opens) else None,
            "high": _pos(g.high.max()),
            "low": float(lows.min()) if len(lows) else None,
            "volume": float(g.vol.sum()),
            "openInterest": _num(last.oi) if has_oi else None,
            "dataTime": (_day_base(day) + _secs(last.t)) * 1000,
        }
    return state


def chain(q: dict) -> dict:
    day = _ymd(q.get("tradingDay"))
    code, expiry, mult = _series(q.get("seriesId"))
    sub = _series_rows(code, day, expiry, mult)
    ticks = _meta_tables()["tick"]
    prev_close = _prev_closes(code, day)
    close_ms = (_day_base(day) + 15 * 3600) * 1000
    replay = q.get("replayAt")
    label = _replay_label(day, replay) if replay else None
    underlying = _underlying(code, day, label)
    quality = [] if underlying else ["missing_underlying"]

    state = _replay_state(code, day, set(sub.c8), label) if label else {}
    T = _years_to_expiry(day, expiry)
    rows: "OrderedDict[float, dict]" = OrderedDict()
    for r in sub.itertuples():
        strike, is_call = float(r.strike), r.call_put == "C"
        quote = {"symbol": r.c8, "name": r.name, "optionType": "C" if is_call else "P",
                 "strikePrice": strike, "priceTick": ticks.get(r.c8, OPT_TICK),
                 "sourceChannel": CHANNEL, "exchange": _exchange(code),
                 "previousSettlement": _pos(r.pre_settle), "previousClose": prev_close.get(r.c8)}
        if label:
            s = state.get(r.c8)
            if s:
                quote.update(s)
                quote["analytics"] = _analytics(underlying["price"] if underlying else None, strike, T,
                                                is_call, s["price"], s["dataTime"])
            else:                           # 该时点之前没有成交：留空，不编造
                quote.update(price=None, open=None, high=None, low=None, volume=None,
                             openInterest=None, dataTime=None, analytics=None)
        else:
            iv = _num(r.iv)
            quote.update(
                price=_pos(r.close), open=_pos(r.open), high=_pos(r.high), low=_pos(r.low),
                volume=_num(r.volume), openInterest=_num(r.oi_web), dataTime=close_ms,
                analytics={
                    "impliedVol": {"value": iv if iv is not None and iv > IV_FLOOR else None, "time": close_ms},
                    "delta": {"value": _num(r.delta), "time": close_ms},
                    "gamma": {"value": _num(r.gamma), "time": close_ms},
                    "vega": {"value": _num(r.vega), "time": close_ms},
                    "theta": {"value": _num(r.theta), "time": close_ms},
                })
        row = rows.setdefault(strike, {"strikePrice": strike, "calls": [], "puts": []})
        row["calls" if is_call else "puts"].append(quote)

    out = {"tradingDay": _iso(day), "status": "closed",
           "dataTime": underlying["dataTime"] if (label and underlying) else close_ms,
           "series": {"id": q["seriesId"], "expiry": _iso(expiry), "multiplier": mult,
                      "underlyingSymbol": code, "underlyingExchange": _exchange(code),
                      "sourceChannel": CHANNEL},
           "underlying": underlying, "rows": list(rows.values()), "quality": quality}
    if label:
        out["replayAt"] = int(replay)
    return out


# ---------- intraday ----------

def _atm_iv(code: str, day: int, sub: pd.DataFrame, T: float, spot: pd.DataFrame) -> list:
    """ATM IV：按当日标的中位价固定一档平值，认购/认沽各解一次取均值。"""
    opt = _minute(code, "1m", day)
    if opt is None or T <= 0:
        return []
    mid = float(np.median(spot.close))
    legs = []
    for side in ("C", "P"):
        g = sub[sub.call_put == side]
        if len(g):
            pick = g.iloc[(g.strike - mid).abs().argsort().iloc[0]]
            px = opt[(opt.c8 == pick.c8) & (opt.close > 0)]
            legs.append((float(pick.strike), side == "C", dict(zip(px.t, px.close))))
    base, out = _day_base(day), []
    for t, S in zip(spot.t, spot.close):
        ivs = [core.iv_vec(float(S), k, T, is_call, float(prices[t]))
               for k, is_call, prices in legs if t in prices]
        ivs = [v for v in ivs if IV_FLOOR < v < 2.99]
        if ivs:
            out.append({"time": base + _secs(t), "value": round(float(np.mean(ivs)), 6)})
    return out


def _spot_bars(code: str, day: int, spot: pd.DataFrame) -> list:
    base = _day_base(day)
    cum_v, cum_a = spot.vol.cumsum(), spot.amount.cumsum()
    # 成交量单位（份 / 手）由 成交额÷成交量÷价格 判定，避免均价差 100 倍
    traded = spot[(spot.vol > 0) & (spot.amount > 0)]
    lot = 1.0
    if len(traded):
        ratio = float(np.median(traded.amount / traded.vol / traded.close))
        lot = 100.0 if ratio > 30 else 1.0
    bars = []
    for t, close, vol, cv, ca in zip(spot.t, spot.close, spot.vol, cum_v, cum_a):
        stamp = base + _secs(t)
        bars.append({"time": stamp, "price": float(close),
                     "averagePrice": float(ca / (cv * lot)) if cv > 0 and ca > 0 else None,
                     "volume": float(vol), "openInterest": None,
                     "snapshot": {"lastPrice": float(close), "openInterest": None,
                                  "cumulativeVolume": float(cv), "dataTime": stamp * 1000}})
    return bars


def _option_bars(day: int, o: pd.DataFrame, mult: int) -> list:
    base = _day_base(day)
    has_oi = "oi" in o.columns
    cum_v, cum_a = o.vol.cumsum(), o.amount.cumsum()
    ois = o.oi if has_oi else [None] * len(o)
    bars = []
    for t, close, vol, cv, ca, oi in zip(o.t, o.close, o.vol, cum_v, cum_a, ois):
        stamp, price, interest = base + _secs(t), _pos(close), _num(oi)
        bars.append({"time": stamp, "price": price,
                     "averagePrice": float(ca / cv / mult) if cv > 0 and ca > 0 else None,
                     "volume": float(vol), "openInterest": interest,
                     "snapshot": {"lastPrice": price, "openInterest": interest,
                                  "cumulativeVolume": float(cv), "dataTime": stamp * 1000}})
    return bars


def intraday(q: dict) -> dict:
    day = _ymd(q.get("tradingDay"))
    code, expiry, mult = _series(q.get("seriesId"))
    symbol = q.get("symbol") or ""
    sub = _series_rows(code, day, expiry, mult)
    spot = _spot(code, day)
    T = _years_to_expiry(day, expiry)
    out = {"tradingDay": _iso(day), "basePrice": None, "baseSource": None,
           "bars": [], "iv": [], "ivStatus": "no_data"}

    if symbol == code:
        if spot is None:
            return out
        prev = _prev_spot_close(code, day)
        out.update(basePrice=prev, baseSource="previousClose" if prev else None,
                   bars=_spot_bars(code, day, spot), iv=_atm_iv(code, day, sub, T, spot))
    else:
        meta = sub[sub.c8 == symbol]
        if meta.empty:
            raise ApiError(404, "该系列没有此合约")
        r = meta.iloc[0]
        settle, close = _pos(r.pre_settle), _prev_closes(code, day).get(symbol)
        out.update(basePrice=settle or close,
                   baseSource="previousSettlement" if settle else "previousClose" if close else None)
        opt = _minute(code, "1m", day)
        o = opt[opt.c8 == symbol] if opt is not None else None
        if o is None or o.empty:
            return out
        out["bars"] = _option_bars(day, o, mult)
        if spot is not None and T > 0:
            smap, base = dict(zip(spot.t, spot.close)), _day_base(day)
            strike, is_call = float(r.strike), r.call_put == "C"
            for t, px in zip(o.t, o.close):
                S = smap.get(t)
                if S and px and px > 0:
                    iv = core.iv_vec(float(S), strike, T, is_call, float(px))
                    if IV_FLOOR < iv < 2.99:
                        out["iv"].append({"time": base + _secs(t), "value": round(iv, 6)})
    out["ivStatus"] = "ok" if out["iv"] else "no_data"
    return out


ENDPOINTS = {"catalog": catalog, "chain": chain, "intraday": intraday}


def handle(endpoint: str, q: dict):
    """返回 (HTTP 状态码, JSON 对象)。"""
    if endpoint == "access":
        return 200, {"ok": True}
    fn = ENDPOINTS.get(endpoint)
    if fn is None:
        return 404, {"detail": "接口不存在"}
    try:
        payload = fn(q)
    except ApiError as e:
        return e.status, {"detail": e.message}
    except Exception:
        traceback.print_exc()
        return 500, {"detail": "行情服务内部错误"}
    return 200, {"schemaVersion": f"option-history-{endpoint}-v1",
                 "asOf": int(time.time() * 1000), **payload}

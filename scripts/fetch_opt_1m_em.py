#!/usr/bin/env python3
"""fetch_opt_1m_em.py — 期权分钟线增量拉取（东财优先 + 新浪财经自动 Fallback 双引擎）。

双引擎设计：
  1. 首选：东方财富 trends2 接口（一次返回最近 5 日完整分时）；
  2. 兜底 (Fallback)：当东财返回空、超时或限流（52 Empty reply）时，
     自动切换至新浪财经官方接口（ak.option_finance_minute_sina），逐合约兜底补齐。

字段统一标准：
  target, code, date, minute, open, high, low, close, volume, amount, trades
  单位：volume=张, amount=元。
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import akshare as ak
import pandas as pd
import pyarrow.parquet as pq

DEFAULT_DATA_ROOT = "/opt/optq/cache" if Path("/opt/optq/cache").exists() else "/home/dahongge/Quant_Database/options/web_opt/parquet"
DATA_ROOT = Path(os.environ.get("OPT_DATA_ROOT", DEFAULT_DATA_ROOT))
OUT = Path(os.environ.get("OPT_PARQUET", "/home/dahongge/Quant_Database/options/web_opt/parquet"))

ETFS = ["510050", "510300", "510500", "588000", "588080",
        "159901", "159915", "159919", "159922"]
API_EM = ("https://push2his.eastmoney.com/api/qt/stock/trends2/get"
          "?secid={m}.{c}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0")


def secid(code: str) -> str:
    # 1000xxxx / 1001xxxx -> 10 (上海)
    # 9000xxxx / 9001xxxx -> 12 (深圳)
    return f"{10 if str(code).startswith('10') else 12}.{code}"


def fetch_em(code: str) -> list[str]:
    """东财 trends2 抓取。"""
    url = API_EM.format(m=secid(code).split(".")[0], c=code)
    for attempt in range(3):
        try:
            out = subprocess.run(
                ["curl", "-s", "-m", "10", "-A", "Mozilla/5.0", url],
                capture_output=True, text=True,
            ).stdout
            d = json.loads(out).get("data")
            if d:
                return d.get("trends") or []
        except Exception:
            pass
        time.sleep(0.15 * (attempt + 1))
    return []


def fetch_sina_fallback(code: str, want_dates: set[str], etf: str) -> list[dict]:
    """新浪财经分时接口兜底 (Fallback)。"""
    try:
        df = ak.option_finance_minute_sina(symbol=code)
        if df.empty or "date" not in df.columns:
            return []
        rows = []
        for r in df.itertuples():
            d_str = str(r.date).replace("-", "")
            if d_str in want_dates:
                px = float(r.price)
                vol = int(float(r.volume))
                amt = float(getattr(r, "average_price", px)) * vol * 10000
                rows.append({
                    "target": etf,
                    "code": code,
                    "date": int(d_str),
                    "minute": str(r.time)[:5],
                    "open": px, "high": px, "low": px, "close": px,
                    "volume": vol,
                    "amount": amt,
                    "trades": 0,
                })
        return rows
    except Exception:
        return []


def chain_codes(etf: str, day: int, traded_only: bool = False, months: int = 0) -> list[str]:
    f = DATA_ROOT / etf / "1d" / f"year={day // 10000}" / "data.parquet"
    if not f.exists():
        alt = Path("/home/dahongge/Quant_Database/options/web_opt/parquet") / etf / "1d" / f"year={day // 10000}" / "data.parquet"
        if alt.exists():
            f = alt
        else:
            return []
    cols = ["code", "date", "volume"] + (["s_month"] if months else [])
    d = pq.read_table(f, columns=cols).to_pandas()
    d = d[d.date == day]
    if months and "s_month" in d and len(d):
        keep = sorted(d.s_month.unique())[:months]
        d = d[d.s_month.isin(keep)]
    if traded_only and "volume" in d:
        t = d[d.volume > 0]
        if len(t):
            d = t
    return sorted({str(c)[:8] for c in d.code})


def bars_to_rows(etf: str, code: str, trends: list[str], dates: set[str]) -> list[dict]:
    rows = []
    for line in trends:
        ts, o, c, h, l, v, amt, _ = line.split(",")
        day = ts[:10].replace("-", "")
        if day not in dates:
            continue
        f = lambda x: float(x) if float(x) > 0 else float(c)
        rows.append({
            "target": etf, "code": code, "date": int(day), "minute": ts[11:16],
            "open": f(o), "high": f(h), "low": f(l), "close": float(c),
            "volume": int(float(v)), "amount": float(amt), "trades": 0,
        })
    return rows


def fetch_contract_with_fallback(args):
    c, etf, want_str, sleep_sec = args
    # 1. 优先东财
    trends = fetch_em(c)
    rows = []
    if trends:
        rows = bars_to_rows(etf, c, trends, want_str)
    # 2. 东财无数据时，自动触发新浪兜底
    if not rows:
        rows = fetch_sina_fallback(c, want_str, etf)
    if sleep_sec:
        time.sleep(sleep_sec)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates")
    ap.add_argument("--etf")
    ap.add_argument("--traded-only", action="store_true")
    ap.add_argument("--months", type=int, default=0, help="只补最近 N 个月份的合约（0=全部）")
    ap.add_argument("--sleep", type=float, default=0.04)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    etfs = [a.etf] if a.etf else ETFS
    dates = [str(x) for x in a.dates.split(",")] if a.dates else None
    total = 0

    for etf in etfs:
        f_1d = DATA_ROOT / etf / "1d" / "year=2026" / "data.parquet"
        if not f_1d.exists():
            f_1d = Path("/home/dahongge/Quant_Database/options/web_opt/parquet") / etf / "1d" / "year=2026" / "data.parquet"
        if not f_1d.exists():
            print(f"! {etf}: 找不到 1d 文件")
            continue

        d1 = pq.read_table(f_1d, columns=["date"]).to_pandas()
        recent = sorted({int(x) for x in d1.date.unique()})[-5:]
        want = [d for d in recent if dates is None or str(d) in dates]
        target_days = [d for d in want if a.force or not (OUT / etf / "1m" / f"year={d//10000}" / f"{d}.parquet").exists()]
        if not target_days:
            continue
        print(f"{etf}: 需补 {target_days}")

        codes = sorted({c for d in target_days
                        for c in chain_codes(etf, d, traded_only=a.traded_only, months=a.months)})
        print(f"  {etf}: 准备拉取 {len(codes)} 个合约 (带新浪 Fallback 机制)...")
        want_str = {str(d) for d in target_days}

        work_items = [(c, etf, want_str, a.sleep) for c in codes]
        all_contract_rows = []
        with ThreadPoolExecutor(max_workers=4) as ex:
            for rows in ex.map(fetch_contract_with_fallback, work_items):
                all_contract_rows.extend(rows)

        if not all_contract_rows:
            print(f"  ! {etf}: 双数据源均无可用分钟数据")
            continue

        df = pd.DataFrame(all_contract_rows)
        for day, g in df.groupby("date"):
            out_file = OUT / etf / "1m" / f"year={day//10000}" / f"{day}.parquet"
            out_file.parent.mkdir(parents=True, exist_ok=True)
            cols = ["target", "code", "date", "minute", "open", "high", "low", "close", "volume", "amount", "trades"]
            res = g[cols].sort_values(["minute", "code"]).reset_index(drop=True)
            res.to_parquet(out_file, index=False)
            total += 1
            print(f"  + {etf} {day}: {len(res)} 行 / {res.code.nunique()} 合约 -> {out_file}")

    print(f"✓ 共写入 {total} 个 1m 文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())

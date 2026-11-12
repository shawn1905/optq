#!/usr/bin/env python3
"""fetch_opt_1m_em.py — 用东财补期权分钟线（补全近期缺口）。

东财 trends2 一次给最近 5 个交易日的 1 分钟走势；期权 secid 市场号：
  沪市期权 1000xxxx / 1001xxxx -> 10.<code>
  深市期权 9000xxxx / 9001xxxx -> 12.<code>

单位与迅投一致：volume=张, amount=元。

用法:
  python3 fetch_opt_1m_em.py                 # 补最近 5 个交易日里缺的 1m 文件
  python3 fetch_opt_1m_em.py --dates 20261111
  python3 fetch_opt_1m_em.py --etf 159919 --dates 20261111
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

# 数据源路径（读 1d 合约列表）
DEFAULT_DATA_ROOT = "/opt/optq/cache" if Path("/opt/optq/cache").exists() else "/home/dahongge/Quant_Database/options/web_opt/parquet"
DATA_ROOT = Path(os.environ.get("OPT_DATA_ROOT", DEFAULT_DATA_ROOT))
# 目标输出路径（写 1m 分钟文件）
OUT = Path(os.environ.get("OPT_PARQUET", "/home/dahongge/Quant_Database/options/web_opt/parquet"))

ETFS = ["510050", "510300", "510500", "588000", "588080",
        "159901", "159915", "159919", "159922"]
API = ("https://push2his.eastmoney.com/api/qt/stock/trends2/get"
       "?secid={m}.{c}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0")


def secid(code: str) -> str:
    # 1000xxxx / 1001xxxx -> 10 (上海)
    # 9000xxxx / 9001xxxx -> 12 (深圳)
    return f"{10 if code.startswith('10') else 12}.{code}"


FAILS = 0


def fetch(code: str) -> list[str]:
    """带退避的重试，失败不永久熔断。"""
    global FAILS
    if FAILS >= 6:
        time.sleep(2.0)
    for attempt in range(4):
        try:
            url = API.format(m=secid(code).split(".")[0], c=code)
            out = subprocess.run(
                ["curl", "-s", "-m", "15", "-A", "Mozilla/5.0", url],
                capture_output=True, text=True,
            ).stdout
            d = json.loads(out).get("data")
            if d:
                FAILS = 0
                return d.get("trends") or []
        except Exception:
            pass
        time.sleep(0.3 * (attempt + 1))
    FAILS += 1
    return []


def chain_codes(etf: str, day: int, traded_only: bool = False, months: int = 0) -> list[str]:
    f = DATA_ROOT / etf / "1d" / f"year={day // 10000}" / "data.parquet"
    if not f.exists():
        # 如果当前位置没有，尝试另一个常见位置
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates")
    ap.add_argument("--etf")
    ap.add_argument("--traded-only", action="store_true")
    ap.add_argument("--months", type=int, default=0, help="只补最近 N 个月份的合约（0=全部）")
    ap.add_argument("--sleep", type=float, default=0.15)
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
        print(f"  {etf}: 准备拉取 {len(codes)} 个合约...")
        want_str = {str(d) for d in target_days}

        def slow_fetch(c):
            t = fetch(c)
            if a.sleep:
                time.sleep(a.sleep)
            return t

        with ThreadPoolExecutor(max_workers=3) as ex:
            trends = dict(zip(codes, ex.map(slow_fetch, codes)))

        rows = []
        for c, t in trends.items():
            rows.extend(bars_to_rows(etf, c, t, want_str))

        if not rows:
            print(f"  {etf}: 东财无可写数据")
            continue

        df = pd.DataFrame(rows)
        for day, g in df.groupby("date"):
            out_file = OUT / etf / "1m" / f"year={day//10000}" / f"{day}.parquet"
            out_file.parent.mkdir(parents=True, exist_ok=True)
            # 保证含有标准列
            cols = ["target", "code", "date", "minute", "open", "high", "low", "close", "volume", "amount", "trades"]
            res = g[cols].sort_values(["minute", "code"]).reset_index(drop=True)
            res.to_parquet(out_file, index=False)
            total += 1
            print(f"  + {etf} {day}: {len(res)} 行 / {res.code.nunique()} 合约 -> {out_file}")

    print(f"✓ 共写入 {total} 个 1m 文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())

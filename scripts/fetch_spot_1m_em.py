#!/usr/bin/env python3
"""fetch_spot_1m_em.py — 从东方财富补 ETF 标的分钟线（spot_1m）。

东财 trends2 一次给最近 5 个交易日的 1 分钟走势，正好覆盖迅投导出滞后的这几天。

字段: "YYYY-MM-DD HH:MM,open,close,high,low,vol(手),amount(元),avg"
      成交量单位是「手」=100 份，写入时 ×100，与迅投口径（份）保持一致。

用法:
  python3 fetch_spot_1m_em.py                 # 补最近 5 个交易日里缺失的日期
  python3 fetch_spot_1m_em.py --dates 20261111 # 只补指定日期
  python3 fetch_spot_1m_em.py --force         # 覆盖已有日期
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

OUT = Path(os.environ.get("OPT_PARQUET", "/home/dahongge/Quant_Database/options/web_opt/parquet"))
CODES = {
    "510050": 1, "510300": 1, "510500": 1, "588000": 1, "588080": 1,
    "159901": 0, "159915": 0, "159919": 0, "159922": 0,
}
API = ("https://push2his.eastmoney.com/api/qt/stock/trends2/get"
       "?secid={m}.{c}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
       "&ndays=5&iscr=0")

FAILS = 0


def fetch(market: int, code: str) -> list[str]:
    global FAILS
    if FAILS >= 5:
        time.sleep(2.0)
    url = API.format(m=market, c=code)
    for attempt in range(4):
        try:
            out = subprocess.run(
                ["curl", "-s", "-m", "15", "-A", "Mozilla/5.0", url],
                capture_output=True, text=True, check=True,
            ).stdout
            trends = (json.loads(out).get("data") or {}).get("trends") or []
            if trends:
                FAILS = 0
                return trends
        except Exception:
            pass
        time.sleep(0.5 * (attempt + 1))
    FAILS += 1
    return []


def to_frame(code: str, trends: list[str]) -> pd.DataFrame:
    rows = []
    for line in trends:
        ts, o, c, h, l, v, amt, _avg = line.split(",")
        rows.append({
            "code": f"{code}.{'SH' if CODES[code]==1 else 'SZ'}",
            "trade_time": ts + ":00",
            "open": float(o), "high": float(h), "low": float(l), "close": float(c),
            "vol": float(v) * 100,          # 手 -> 份
            "amount": float(amt),
            "date": ts[:10].replace("-", ""),
        })
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    for col in ("open", "high", "low"):
        df[col] = df.apply(lambda r: r["close"] if r[col] <= 0 else r[col], axis=1)
    df["vwap"] = [a / v if v > 0 else c for a, v, c in zip(df["amount"], df["vol"], df["close"])]
    return df[["code", "trade_time", "open", "high", "low", "close", "vol", "amount", "vwap", "date"]]


def path_of(code: str, day: str) -> Path:
    return OUT / code / "spot_1m" / f"year={day[:4]}" / f"{day}.parquet"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dates")
    a = ap.parse_args()

    want_dates = {str(d) for d in a.dates.split(",")} if a.dates else None
    written = skipped = 0
    for code, market in CODES.items():
        try:
            df = to_frame(code, fetch(market, code))
        except Exception as e:
            print(f"! {code} 获取失败: {e}")
            continue
        if df.empty:
            print(f"! {code} 无数据")
            continue
        for day, g in df.groupby("date"):
            if want_dates and day not in want_dates:
                continue
            f = path_of(code, day)
            if f.exists() and not a.force:
                skipped += 1
                continue
            f.parent.mkdir(parents=True, exist_ok=True)
            g.to_parquet(f, index=False)
            written += 1
            print(f"+ {code} {day} {len(g)} 分钟")

    print(f"✓ 写入 {written} 个标的文件，跳过已存在 {skipped} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""把 ETF 1 分钟全市场文件，拆成 9 只标的的 spot_1m 分日 parquet。

输入  ~/Downloads/ETF/分钟K线/1m/<year>.zip            (2010-2026)
      ~/Downloads/ETF/分钟K线/1m/2026/YYYYMMDD.parquet  (增量)
输出  OUT/<code>/spot_1m/year=YYYY/YYYYMMDD.parquet

用法: python3 import_spot_1m.py --out /tmp/spot_out [--years 2015-2026]
"""
import argparse
import io
import shutil
import sys
import zipfile
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

SRC = Path.home() / "Downloads/ETF/分钟K线/1m"
CODES = {
    "510050.SH": "510050", "510300.SH": "510300", "510500.SH": "510500",
    "159901.SZ": "159901", "159915.SZ": "159915", "159919.SZ": "159919",
    "159922.SZ": "159922", "588000.SH": "588000", "588080.SH": "588080",
}


def write_day(table, out: Path) -> int:
    d = table.to_pandas()
    d["code"] = d["code"].astype(str)
    d = d[d["code"].isin(CODES)]
    if d.empty:
        return 0
    n = 0
    for full, g in d.groupby("code"):
        code = CODES[full]
        day = str(g["date"].iloc[0])
        f = out / code / "spot_1m" / f"year={day[:4]}" / f"{day}.parquet"
        f.parent.mkdir(parents=True, exist_ok=True)
        g.to_parquet(f, index=False)
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--years", default="2015-2026")
    a = ap.parse_args()
    out = Path(a.out).expanduser()
    lo, hi = (int(x) for x in a.years.split("-"))

    done = 0
    for year in range(lo, hi + 1):
        z = SRC / f"{year}.zip"
        if z.exists():
            with zipfile.ZipFile(z) as zf:
                names = [n for n in zf.namelist() if n.endswith(".parquet")]
                for n in sorted(names):
                    t = pq.read_table(io.BytesIO(zf.read(n)))
                    done += write_day(t, out)
            print(f"{year}: {len(names)} days -> {done} files", flush=True)
        d = SRC / str(year)
        if d.is_dir():
            files = sorted(d.glob("*.parquet"))
            for f in files:
                done += write_day(pq.read_table(f), out)
            if files:
                print(f"{year}/: {len(files)} days -> {done} files", flush=True)

    # 只保留 9 只标的
    for child in out.iterdir():
        if child.is_dir() and child.name not in CODES.values():
            shutil.rmtree(child)
    print("total files", done)


if __name__ == "__main__":
    sys.exit(main())

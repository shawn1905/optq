#!/usr/bin/env python3
"""backfill_1m_from_store.py — 从权威层回填 ETF 期权分钟到 web 层。

【安全约束】
  * 只读权威层：/volume1/exchangeFILE/backup/Quant_Database/options/1m_opt/<年>/<日期>.parquet
  * 只写 web 层：<WEB>/<标的>/1m/year=<年>/<日期>.parquet
  * 原子写入：先写 .part 再 os.replace，不会留下半个文件
  * 默认「不覆盖已存在文件」；只有显式 --force 且日期 < --before 才允许覆盖
  * 每写一个文件都记入 manifest，便于事后审计

用法:
  python3 backfill_1m_from_store.py --years 2015-2025 --before 20251022 --force
  python3 backfill_1m_from_store.py --date 20260401
"""
import argparse
import glob
import os
import sys

import pandas as pd
import pyarrow.parquet as pq

STORE = "/volume1/exchangeFILE/backup/Quant_Database/options/1m_opt"
WEB = "/home/dahongge/Quant_Database/options/web_opt/parquet"
MANIFEST = "/home/dahongge/backfill_manifest.tsv"
CODES = ["510050", "510300", "510500", "588000", "588080",
         "159901", "159915", "159919", "159922"]
COLS = ["target", "code", "date", "minute", "open", "high", "low", "close",
        "volume", "amount", "trades", "oi"]


def contract_map() -> dict[str, str]:
    m = {}
    for c in CODES:
        for f in glob.glob(f"{WEB}/{c}/1d/year=*/data.parquet"):
            d = pq.read_table(f, columns=["code", "underlying"]).to_pandas()
            for code, und in zip(d.code.astype(str), d.underlying.astype(str)):
                m[code[:8]] = und
    return m


def write_atomic(df: pd.DataFrame, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def process(day_file: str, cmap: dict[str, str], force: bool, before: int, log) -> tuple[int, int]:
    day = int(os.path.basename(day_file).split(".")[0])
    # 读：只取需要的列，权威层不做任何修改
    want = ["code", "trade_time", "open", "high", "low", "close", "vol", "amount", "oi"]
    have = set(pq.read_schema(day_file).names)
    d = pq.read_table(day_file, columns=[c for c in want if c in have]).to_pandas()
    if "oi" not in d.columns:
        d["oi"] = float("nan")
    d["c8"] = d.code.astype(str).str[:8]
    d = d[d.c8.str.fullmatch(r"\d{8}")]          # ETF 期权：8 位纯数字
    if d.empty:
        return 0, 0
    d["target"] = d.c8.map(cmap)
    d = d[d.target.notna()]
    if d.empty:
        return 0, 0

    wrote = skipped = 0
    for target, g in d.groupby("target"):
        out_path = f"{WEB}/{target}/1m/year={day//10000}/{day}.parquet"
        exists = os.path.exists(out_path)
        if exists and not (force and day < before):
            skipped += 1
            continue
        out = pd.DataFrame({
            "target": target,
            "code": g.c8,
            "date": day,
            "minute": g.trade_time.astype(str).str[11:16],
            "open": g.open, "high": g.high, "low": g.low, "close": g.close,
            "volume": g.vol.fillna(0).astype("int64"),
            "amount": g.amount.fillna(0.0),
            "trades": 0,
            "oi": g.oi.astype("float64"),
        })[COLS]
        write_atomic(out, out_path)
        log.write(f"{day}\t{target}\t{len(out)}\t{out_path}\n")
        wrote += 1
    return wrote, skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2015-2025")
    ap.add_argument("--date")
    ap.add_argument("--before", type=int, default=20251022,
                    help="只有早于这个日期的文件允许被覆盖（默认 2025-10-22）")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    cmap = contract_map()
    print(f"合约映射 {len(cmap)} 条", flush=True)

    if a.date:
        files = sorted(glob.glob(f"{STORE}/*/{a.date}.parquet"))
    else:
        lo, hi = (int(x) for x in a.years.split("-")) if "-" in a.years else (int(a.years), int(a.years))
        files = []
        for y in range(lo, hi + 1):
            files += sorted(glob.glob(f"{STORE}/{y}/*.parquet"))

    total_w = total_s = 0
    with open(MANIFEST, "a") as log:
        for i, f in enumerate(files, 1):
            w, s = process(f, cmap, a.force, a.before, log)
            total_w += w
            total_s += s
            if w:
                print(f"[{i}/{len(files)}] {os.path.basename(f)[:8]} 写入 {w}，跳过 {s}", flush=True)
            elif i % 100 == 0:
                print(f"[{i}/{len(files)}] 扫描中…", flush=True)
    print(f"✓ 共写入 {total_w} 个 web 文件，跳过已存在 {total_s} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())

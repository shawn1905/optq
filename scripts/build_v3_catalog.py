#!/usr/bin/env python3
"""build_v3_catalog.py — 生成 V3 页面用的「目录索引」（派生小文件）。

【安全约束】
  * 只读：web 层日线 <WEB>/<标的>/1d/year=*/data.parquet
          权威层 opt_basic.parquet（合约乘数、最小变动价位）
  * 只写：<WEB>/_v3/catalog.parquet、<WEB>/_v3/contracts.parquet（原子写）

catalog.parquet   每个交易日有哪些期权系列：date, code, expiry, multiplier, n
contracts.parquet 合约属性：c8, multiplier, tick

由 daily_increment.sh 在盘后调用；也可手动运行。
"""
import glob
import os
import sys

import pandas as pd
import pyarrow.parquet as pq

BASIC = "/volume1/exchangeFILE/backup/Quant_Database/options/opt_basic.parquet"
WEB = "/home/dahongge/Quant_Database/options/web_opt/parquet"
OUT = f"{WEB}/_v3"
CODES = ["510050", "510300", "510500", "588000", "588080",
         "159901", "159915", "159919", "159922"]


def write_atomic(df: pd.DataFrame, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def main() -> int:
    basic = pq.read_table(BASIC, columns=["code", "opt_multiplier", "min_price_chg"]).to_pandas()
    basic["c8"] = basic.code.astype(str).str[:8]
    basic = basic[basic.c8.str.fullmatch(r"\d{8}")].drop_duplicates("c8")
    basic["multiplier"] = pd.to_numeric(basic.opt_multiplier, errors="coerce")
    basic["tick"] = pd.to_numeric(basic.min_price_chg, errors="coerce")

    frames = []
    for code in CODES:
        for f in sorted(glob.glob(f"{WEB}/{code}/1d/year=*/data.parquet")):
            d = pq.read_table(f, columns=["code", "date", "expiry"]).to_pandas()
            d["c8"] = d.code.astype(str).str[:8]
            d["underlying"] = code
            frames.append(d[["underlying", "c8", "date", "expiry"]])
    if not frames:
        print("! 没有日线数据", file=sys.stderr)
        return 1
    days = pd.concat(frames, ignore_index=True)
    days = days.merge(basic[["c8", "multiplier", "tick"]], on="c8", how="left")
    days["multiplier"] = days.multiplier.fillna(10000).round().astype("int32")
    days["tick"] = days.tick.fillna(0.0001)

    contracts = (days.drop_duplicates("c8")[["c8", "underlying", "multiplier", "tick"]]
                 .sort_values("c8").reset_index(drop=True))
    catalog = (days.groupby(["date", "underlying", "expiry", "multiplier"]).size()
               .reset_index(name="n").rename(columns={"underlying": "code"}))
    catalog["date"] = catalog.date.astype("int32")
    catalog["expiry"] = catalog.expiry.astype("int32")
    catalog["n"] = catalog.n.astype("int32")

    write_atomic(catalog, f"{OUT}/catalog.parquet")
    write_atomic(contracts, f"{OUT}/contracts.parquet")
    print(f"✓ catalog {len(catalog)} 行（{catalog.date.nunique()} 个交易日，"
          f"{catalog.date.min()}~{catalog.date.max()}），contracts {len(contracts)} 个合约，"
          f"非标准乘数 {int((contracts.multiplier != 10000).sum())} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())

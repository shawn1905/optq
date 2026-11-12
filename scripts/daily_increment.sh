#!/usr/bin/env bash
# daily_increment.sh — 盘后增量补数（唯一入口，quant-eod 流水线末尾调用）
#
# 设计原则：NAS 是唯一数据源，云端只做按需读 + 小缓存，不做整库拷贝。
#   1. 导入投放目录里的 ETF 分钟包（NAS 本地）
#   2. 在云端用东财补当天缺失的 ETF/期权分钟，写入云端临时目录
#   3. 把新增的分日文件（每天 18 个，几 MB）回写 NAS 主库
#
# 用法: ./daily_increment.sh            # 补最近 5 个交易日里缺的
#       ./daily_increment.sh 20261112  # 只处理指定日期
set -uo pipefail

HERE=/home/dahongge/quant-database/nas/scripts
PY=/home/dahongge/quant-env/bin/python3
ROOT=/home/dahongge/Quant_Database/options/web_opt/parquet
CLOUD_APP=/opt/optq/app
STAGE=/tmp/optq_stage
LOG=/home/dahongge/daily_increment.log
FILTER=""
[ $# -gt 0 ] && FILTER="--dates $1"

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 增量补数开始 ====="

# 1) 投放目录（NAS 本地）
"$PY" "$HERE/import_spot_1m.py" || echo "! 投放目录导入失败"

# 2) 云端补缺口（东财），只写临时目录
ssh -o BatchMode=yes -o ConnectTimeout=10 cloud \
  "mkdir -p $STAGE && cd $CLOUD_APP && \
   OPT_PARQUET=$STAGE python3 fetch_spot_1m_em.py; \
   OPT_PARQUET=$STAGE python3 fetch_opt_1m_em.py $FILTER --months 2 --sleep 0.3" \
  || echo "! 云端补数失败"

# 3) 回写 NAS（只传新增的分日文件，通常 <10MB）
if ssh -o BatchMode=yes cloud "test -d $STAGE && find $STAGE -name '*.parquet' | grep -q ."; then
  rsync -a --ignore-existing --timeout=300 cloud:$STAGE/ "$ROOT/"
  ssh -o BatchMode=yes cloud "rm -rf $STAGE"
  echo "✓ 回写完成"
else
  echo "· 云端没有新增文件"
fi

# 4) 刷新 V3 页面的目录索引（派生小文件）
"$PY" "$HERE/build_v3_catalog.py" || echo "! V3 目录索引生成失败"

echo "===== $(date '+%F %T') 增量补数结束 ====="

# OPTQ — ETF 期权历史行情工作台 (Option Terminal)

一套面向全历史（2015-02 至今）ETF 期权的交互式量化研究与历史行情回放工作台。前端提供 Bloomberg 终端黑金风格的 T 型期权链、双分时图（标的 + 期权）、逐分钟盘口回放及 IV / Greeks 走势。

架构采用**「NAS 存储层作为唯一真值 + 云端轻量无状态读（带 2GB LRU 缓存）」**，在百兆私有网络下实现秒级响应。

---

## 1. 架构总览 (Architecture)

```
┌─────────────────────────────────────────────────────────────┐
│                      用户浏览器 (Browser)                    │
│           访问根路径 / 或 /index.html (彭博黑金旗舰版)          │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / WebSocket
┌──────────────────────────────▼──────────────────────────────┐
│                    云端 Web 服务 (Cloud Server)              │
│       Python 3 (ThreadingHTTPServer) + 轻量本地 LRU 缓存     │
│        - /opt/optq/app/server.py                            │
│        - /opt/optq/app/v3_api.py (HiTick 契约适配器)          │
│        - /opt/optq/cache/ (上限 2GB, LRU 自动淘汰)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ 按需取数 (SSH cat / rsync)
┌──────────────────────────────▼──────────────────────────────┐
│                    NAS 存储层 (NAS Parquet Root)            │
│  /home/dahongge/Quant_Database/options/web_opt/parquet/     │
│    ├── <标的代码>/1d/year=YYYY/data.parquet      (日线+Greeks)│
│    ├── <标的代码>/1m/year=YYYY/YYYYMMDD.parquet  (期权分钟线) │
│    ├── <标的代码>/spot_1m/year=YYYY/YYYYMMDD.parquet (标的分钟)│
│    └── _v3/catalog.parquet, contracts.parquet    (目录索引)   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 覆盖品种与数据说明 (Data Coverage)

涵盖中国市场全部 9 只主流 ETF 期权（自每只期权上市首日至今无断层）：

| 标的代码 | 标的简称 | 期权上市日 | 分钟线覆盖范围 | 乘数 (标准 / 调整) |
|---|---|---|---|---|
| **510050** | 上证50ETF | 2015-02-09 | 2015-02-09 ~ 至今 (2855+ 天) | 10,000 |
| **510300** | 沪深300ETF | 2019-12-23 | 2019-12-23 ~ 至今 (1668+ 天) | 10,000 |
| **510500** | 中证500ETF | 2022-09-19 | 2022-09-19 ~ 至今 (1003+ 天) | 10,000 / 10,180 等 |
| **588000** | 科创50ETF | 2023-06-05 | 2023-06-05 ~ 至今 (833+ 天) | 10,000 |
| **588080** | 科创板50ETF | 2023-06-05 | 2023-06-05 ~ 至今 (833+ 天) | 10,000 |
| **159901** | 深证100ETF | 2022-12-12 | 2022-12-12 ~ 至今 (948+ 天) | 10,000 |
| **159915** | 创业板ETF | 2022-09-19 | 2022-09-19 ~ 至今 (1003+ 天) | 10,000 |
| **159919** | 沪深300ETF(深) | 2019-12-23 | 2019-12-23 ~ 至今 (1668+ 天) | 10,000 |
| **159922** | 中证500ETF(深) | 2022-09-19 | 2022-09-19 ~ 至今 (1003+ 天) | 10,000 |

- **全量归档压缩包**：`web_opt_parquet_archive.tar.gz`（全部历史 Parquet 数据压缩后约 2.6 GB，解压后约 3.2 GB）。

---

## 3. 面向 Agent 的部署指南 (Agent Runbook)

### 3.1 环境要求
- **Python**: `>= 3.10`
- **系统依赖**: `curl`, `rsync`, `ssh`, `openssh-client`
- **Python 依赖库**:
  ```bash
  pip install pandas pyarrow numpy scipy
  ```

### 3.2 部署步骤 (云端或单机部署)

#### 模式 A：单机全本地部署 (数据与服务在同一台机器)
1. **解压数据包**：
   ```bash
   mkdir -p /data/optq/parquet
   tar -xzf web_opt_parquet_archive.tar.gz -C /data/optq/
   # 解压后目录为 /data/optq/parquet/<标的代码>/...
   ```
2. **生成目录索引**（首次部署或数据更新时必跑）：
   ```bash
   python3 scripts/build_v3_catalog.py
   # 索引写入 /data/optq/parquet/_v3/catalog.parquet 与 contracts.parquet
   ```
3. **启动服务**：
   ```bash
   python3 server.py \
     --host 0.0.0.0 \
     --port 8787 \
     --nas-host localhost \
     --nas-root /data/optq/parquet
   ```

#### 模式 B：分离部署 (数据在 NAS，服务在云端轻量虚机)
1. **NAS 侧准备**：
   - 保持数据存放在 NAS 目录（如 `/home/dahongge/Quant_Database/options/web_opt/parquet`）。
   - 确保云端机器可通过 SSH 免密公钥登录 NAS。
2. **云端虚机配置**：
   - 将本仓库代码放置在 `/opt/optq/app/`。
   - 创建缓存目录：`mkdir -p /opt/optq/cache`。
   - 配置 Systemd 服务 `/etc/systemd/system/optq.service`：
     ```ini
     [Unit]
     Description=Option Terminal (optq)
     After=network.target

     [Service]
     Type=simple
     User=ubuntu
     WorkingDirectory=/opt/optq/app
     ExecStart=/usr/bin/python3 server.py --host 127.0.0.1 --port 8787 --nas-host <NAS_SSH_USER@NAS_IP> --nas-root /home/dahongge/Quant_Database/options/web_opt/parquet
     Restart=on-failure
     RestartSec=3

     [Install]
     WantedBy=multi-user.target
     ```
   - 启动并启用服务：
     ```bash
     sudo systemctl daemon-reload
     sudo systemctl enable --now optq
     ```
3. **Nginx 反向代理配置 (带 Basic Auth)**：
   ```nginx
   location /optq/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       auth_basic "Option History Terminal";
       auth_basic_user_file /etc/nginx/.htpasswd_optq;
   }
   ```

### 3.3 自动化增量维护配置 (Daily Incremental Setup)

盘后数据自动增量同步遵循**单一调度入口**原则，无需人工干预，通过 Linux Systemd Timer 或 Crontab 每天 18:30 自动执行：

#### 1. 增量脚本清单 (`scripts/` 目录)
- `daily_increment.sh`：主控入口脚本，按顺序执行导入、云端补缺口、回写与索引刷新；
- `import_spot_1m.py`：自动解析日间投放目录中的 ETF 现券分钟数据；
- `fetch_spot_1m_em.py`：东方财富接口兜底抓取标的现券分钟数据（自动校准手数与份数换算）；
- `fetch_opt_1m_em.py`：东方财富接口抓取 ETF 期权分钟数据（带 `--months 0` 全到期月份覆盖与防限流指数退避）；
- `build_v3_catalog.py`：极轻量索引生成器（秒级执行），扫描全量日线更新 `_v3/` 目录索引。

#### 2. 定时任务配置 (Systemd Timer 推荐)
创建 `/etc/systemd/system/optq-incremental.service`：
```ini
[Unit]
Description=OPTQ Daily Incremental Sync
After=network.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/optq/app
ExecStart=/opt/optq/app/scripts/daily_increment.sh
TimeoutSec=3600
```

创建 `/etc/systemd/system/optq-incremental.timer`：
```ini
[Unit]
Description=Run OPTQ Daily Incremental Sync every trading day at 18:30

[Timer]
OnCalendar=Mon..Fri 18:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

启用定时器：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now optq-incremental.timer
systemctl list-timers optq-incremental.timer
```
*(如习惯使用 Crontab，可添加：`30 18 * * 1-5 /opt/optq/app/scripts/daily_increment.sh >> /var/log/optq_increment.log 2>&1`)*

#### 3. 增量链路内部流转时序
1. **Step 1 (本地标的分时导入)**：`import_spot_1m.py` 扫描本地投放目录 `/volume1/transfer/etf_1m_incoming`（如有迅投导出的当日 ETF 标的 1m 分钟包则解析入库）；
2. **Step 2 (云端东财兜底抓取)**：触发 `fetch_spot_1m_em.py` 与 `fetch_opt_1m_em.py --months 0`，若白天本地未导出或期权分钟滞后，自动抓取当天 9 只标的及全部期权合约分钟线至临时暂存目录 `/tmp/optq_stage`；
3. **Step 3 (轻量增量回写)**：执行 `rsync -a --ignore-existing` 将暂存分日文件写回 Web 库（每天增量约 18 个 parquet 文件，仅约 10MB），清空暂存区；
4. **Step 4 (索引秒级刷新)**：执行 `build_v3_catalog.py` 更新 `_v3/catalog.parquet`，前端页面在不重启服务的情况下当天立即可见新交易日的日历与期权链。

---

## 5. 前端功能特性

本仓库已收敛为**单一纯净的 V3 旗舰前端**（基于 HiTick 1:1 结构复刻 + 彭博社土豪金定制配色）：
- **T 型期权链（14 列）**：涵盖合约代码、Theta、Vega、Gamma、Delta、IV、成交量、持仓量、昨结价、昨收价、最低价、最高价、开盘价、收盘/末价；
- **全真回放**：点击分时图任意时点回放期权链，支持 `←` / `→` 逐分钟步进与实时 Greeks/IV 反解；
- **双阶梯分时图**：规范阶梯折线，高于昨结/昨收红、低于绿，集成成交量柱、持仓量折线、ATM IV、合约 IV 与右侧分钟快照；
- **三栏选择器**：标的 → 到期日 → 合约乘数（智能区分标准合约与分红除权 A 调整合约）；
- **主题切换**：默认彭博深黑金（#060709 底色 + #e5b34b 琥珀金），支持右上角深色/浅色一键切换。

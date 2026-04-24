# 数据库连接与数据字典

本文档整理本项目当前使用的两类核心数据库：

- `ClickHouse`：行情时序数据、扫描结果
- `PostgreSQL`：元数据、任务队列、用户与业务状态

文档内容来源于当前仓库中的如下文件：

- `docker-compose.yml`
- `backend/core/clickhouse_client.py`
- `scripts/init_clickhouse.py`
- `backend/core/pg_database.py`
- `backend/core/models.py`
- `scripts/init_postgresql_tables.py`
- `backend/core/market_scanner/schema.py`
- `backend/scripts/migrations/*.sql`
- `backend/migrations/**/*.sql`

---

## 1. 环境连接信息

### 1.1 本地开发环境

#### ClickHouse

- Host: `localhost`
- HTTP Port: `18123`
- Native Port: `19000`
- Database: `stock_data`
- User: `default`
- Password: 空

连接示例：

```bash
# HTTP
curl 'http://localhost:18123/?query=SELECT%201'

# Native client
clickhouse-client --host localhost --port 19000 --user default --password ''
```

#### PostgreSQL

- Host: `localhost`
- Port: `15432`
- Database: `stock_data`
- User: `admin`
- Password: `admin123`

连接示例：

```bash
psql -h localhost -p 15432 -U admin -d stock_data
```

#### Python 连接串

- ClickHouse（项目默认）：
  - `clickhouse://default:@localhost:18123/stock_data`（概念表示）
- PostgreSQL：
  - `postgresql://admin:admin123@localhost:15432/stock_data`

### 1.2 生产环境

生产服务器信息：

- Server: `wxk@111.228.59.57`
- Project Path: `~/stock-analysys`

说明：

- 生产数据库端口通常绑定在服务器本机，不建议直接公网暴露后长期使用
- 推荐通过 SSH 登录服务器后本机连接，或通过 SSH Tunnel 使用

SSH 登录：

```bash
ssh wxk@111.228.59.57
```

服务器内连接：

```bash
# ClickHouse
clickhouse-client --host localhost --port 19000

# PostgreSQL
psql -h localhost -p 15432 -U admin -d stock_data
```

SSH Tunnel 示例：

```bash
# PostgreSQL
ssh -L 15432:127.0.0.1:15432 wxk@111.228.59.57

# ClickHouse HTTP
ssh -L 18123:127.0.0.1:18123 wxk@111.228.59.57

# ClickHouse Native
ssh -L 19000:127.0.0.1:19000 wxk@111.228.59.57
```

---

## 2. 数据库职责划分

### 2.1 ClickHouse

用于保存高频、时序、大体量读多写多的数据：

- 股票日线 `stock_daily`
- 股票 5 分钟线 `stock_minute5`
- 实时快照 `stock_realtime_snapshot`
- 股票主数据 `stock_list`
- 交易日历 `trading_calendar`
- 扫描结果 `scan_results`

### 2.2 PostgreSQL

用于保存事务型、元数据、权限和任务数据：

- 元数据日志：同步、下载、数据质量、API 调用
- 用户与权限
- 参数训练任务、参数结果
- 持仓、交易信号、交易记录
- 市场扫描日志

---

## 3. ClickHouse 数据字典

### 3.1 `stock_data.stock_list`

用途：

- 股票基础信息主表
- 作为全市场股票池、代码搜索、状态过滤的基础表

建表来源：

- `backend/core/clickhouse_client.py`
- `scripts/init_clickhouse.py`

主键/排序键：

- `ORDER BY code`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | `String` | 股票代码，格式如 `sh.600000`、`sz.000001` |
| `name` | `String` | 股票名称 |
| `list_date` | `Nullable(Date)` | 上市日期 |
| `delist_date` | `Nullable(Date)` | 退市日期，未退市则为空 |
| `exchange` | `Nullable(String)` | 交易所，常见为 `SSE` / `SZSE` |
| `industry` | `Nullable(String)` | 行业字段，当前很多流程未强依赖 |
| `sector` | `Nullable(String)` | 板块/分组字段 |
| `status` | `Nullable(UInt8)` | 状态；通常 `1` 为活跃，非 `1` 代表非活跃/退市/过滤状态 |
| `is_st` | `Nullable(UInt8)` | 是否 ST |
| `update_time` | `DateTime` | 记录更新时间，用于 ReplacingMergeTree 去重 |

备注：

- 该表用于快速构造有效股票池
- 代码中常结合 `status` 做活跃股票过滤

### 3.2 `stock_data.stock_daily`

用途：

- 股票日线历史行情主表
- 多数指标、市场扫描、回测都依赖该表

主键/排序键：

- `PARTITION BY toYYYYMM(date)`
- `ORDER BY (code, date)`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | `String` | 股票代码 |
| `date` | `Date` | 交易日期 |
| `open` | `Float64` | 开盘价 |
| `high` | `Float64` | 最高价 |
| `low` | `Float64` | 最低价 |
| `close` | `Float64` | 收盘价 |
| `preclose` | `Float64` | 前收盘价 |
| `volume` | `Float64` | 成交量 |
| `amount` | `Float64` | 成交额 |
| `adjustflag` | `String` | 复权标记 |
| `turn` | `Float64` | 换手率 |
| `tradestatus` | `String` | 交易状态 |
| `pctChg` | `Float64` | 涨跌幅 |
| `isST` | `String` | 是否 ST |
| `update_time` | `DateTime` | 数据更新时间 |

数据解释：

- 一只股票同一交易日可能因补采/修复而存在多版本
- 表引擎是 `ReplacingMergeTree(update_time)`，按 `update_time` 保留最新记录
- 查询时应优先使用 `argMax(..., update_time)` 去重，不建议大量使用 `FINAL`

### 3.3 `stock_data.stock_minute5`

用途：

- 5 分钟 K 线数据
- 用于盘中分析、分钟级策略与持仓实时快照聚合

主键/排序键：

- `PARTITION BY toYYYYMM(datetime)`
- `ORDER BY (code, datetime)`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | `String` | 股票代码 |
| `datetime` | `DateTime` | 5 分钟 K 线时间点 |
| `open` | `Float64` | 开盘价 |
| `high` | `Float64` | 最高价 |
| `low` | `Float64` | 最低价 |
| `close` | `Float64` | 收盘价 |
| `volume` | `Float64` | 成交量 |
| `amount` | `Float64` | 成交额 |
| `update_time` | `DateTime` | 记录更新时间 |

备注：

- 旧初始化脚本里曾出现 `date + time` 形式；当前核心客户端以 `datetime` 为准
- 使用文档或 SQL 时优先参考 `backend/core/clickhouse_client.py`

### 3.4 `stock_data.stock_realtime_snapshot`

用途：

- 盘中实时快照落表
- 为持仓实时监控、盘中投影、分钟级聚合提供原始输入

主键/排序键：

- `PARTITION BY toYYYYMM(datetime)`
- `ORDER BY (code, datetime)`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | `String` | 股票代码 |
| `datetime` | `DateTime` | 快照时间 |
| `open` | `Float64` | 开盘价 |
| `high` | `Float64` | 最高价 |
| `low` | `Float64` | 最低价 |
| `current` | `Float64` | 当前价 |
| `pre_close` | `Float64` | 前收 |
| `volume` | `Float64` | 累计成交量 |
| `amount` | `Float64` | 累计成交额 |
| `update_time` | `DateTime` | 记录更新时间 |

### 3.5 `stock_data.trading_calendar`

用途：

- 交易日判断
- 调度、扫描、数据新鲜度校验的核心辅助表

主键/排序键：

- `ORDER BY date`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `date` | `Date` | 日期 |
| `is_trading_day` | `UInt8` | 是否交易日，`1` 表示交易日 |
| `exchange` | `String` | 适用交易所，默认 `SSE,SZSE` |
| `day_of_week` | `UInt8` | 周几 |
| `is_month_end` | `UInt8` | 是否月末交易日 |
| `is_quarter_end` | `UInt8` | 是否季末交易日 |
| `is_year_end` | `UInt8` | 是否年末交易日 |
| `update_time` | `DateTime` | 更新时间 |

### 3.6 `scan_results`

用途：

- 保存一次市场扫描的命中股票结果
- 供扫描历史、结果回放、预选池/精选池展示使用

建表来源：

- `backend/core/market_scanner/schema.py`
- `backend/migrations/clickhouse/*.sql`

主键/排序键：

- `PARTITION BY toYYYYMM(scan_time)`
- `ORDER BY (strategy_id, scan_time, score)`

字段说明：

| 字段 | 类型 | 含义 |
|---|---|---|
| `scan_id` | `String` | 扫描任务 ID |
| `strategy_id` | `String` | 旧字段，历史遗留概念 |
| `method_id` | `String` | 扫描方法 ID，如 `breakout` |
| `scan_time` | `DateTime` | 扫描执行时间 |
| `code` | `String` | 股票代码 |
| `name` | `String` | 股票名称 |
| `scan_day_close` | `Float64` | 扫描当日收盘价/合并后的日线收盘价 |
| `signal_tier` | `String` | 信号池层级，如 `standard` / `preselect` / `elite` |
| `signal_tier_label` | `String` | 层级中文名 |
| `signal_tier_reason` | `String` | 进入该层级的原因 |
| `signal_tier_priority` | `UInt8` | 层级优先级，数值越小通常优先级越高 |
| `trigger_reason` | `String` | 触发原因摘要 |
| `atr_value` | `Float64` | ATR 值 |
| `volume_ratio` | `Float64` | 量比 |
| `price_to_support` | `Float64` | 到支撑位距离 |
| `price_to_resistance` | `Float64` | 到压力位距离 |
| `score` | `Float64` | 扫描评分 |
| `buying_pressure_ratio` | `Float32` | 买盘压力比（突破法） |
| `momentum_reversal` | `UInt8` | 动量反转标志 |
| `fomo_acceleration` | `Float32` | FOMO 加速度指标 |
| `volatility_ratio` | `Float32` | 波动率比值（日内/短线法） |
| `trend_status` | `String` | 趋势状态 |
| `close_change_ratio` | `Float32` | 收盘变化比值 |

备注：

- 该表是扫描“结果明细表”，不是扫描执行日志表
- 其中 `strategy_id` 与 `method_id` 存在历史兼容并存情况，读写时优先关注 `method_id`

---

## 4. PostgreSQL 数据字典

PostgreSQL 当前实际由三类结构组成：

- `metadata` schema：同步与系统元数据
- `users` schema：账号与权限
- `public` schema：业务运行表（很多通过 SQL migration 创建）

另外，代码中还定义了 `business` schema ORM 模型，但当前仓库初始化脚本未显式创建 `business` schema；实际运行更依赖 `public` 下的迁移表。

### 4.1 连接信息

项目默认连接串：

```text
postgresql://admin:admin123@localhost:15432/stock_data
```

代码来源：

- `backend/core/pg_database.py`

### 4.2 `metadata.api_counter`

用途：

- 记录每日 API 调用总量与配额

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `date` | `Date` | 日期，主键 |
| `count` | `Integer` | 当日已调用次数 |
| `daily_limit` | `Integer` | 当日配额上限 |
| `update_time` | `DateTime` | 更新时间 |

### 4.3 `metadata.download_progress`

用途：

- 批量下载某个任务的进度追踪

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `task_id` | `String(64)` | 任务 ID，主键 |
| `code` | `String(20)` | 股票代码 |
| `data_type` | `String(20)` | 数据类型，如 `daily` / `minute5` |
| `start_date` | `Date` | 下载起始日期 |
| `end_date` | `Date` | 下载结束日期 |
| `status` | `String(20)` | 任务状态 |
| `progress` | `Integer` | 进度百分比 |
| `total_days` | `Integer` | 总天数 |
| `completed_days` | `Integer` | 已完成天数 |
| `error_msg` | `Text` | 错误信息 |
| `create_time` | `DateTime` | 创建时间 |
| `update_time` | `DateTime` | 更新时间 |

### 4.4 `metadata.sync_history`

用途：

- 单只股票、单类数据的同步历史记录

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 主键 |
| `code` | `String(20)` | 股票代码 |
| `data_type` | `String(20)` | 数据类型 |
| `sync_date` | `Date` | 同步对应日期 |
| `record_count` | `Integer` | 同步记录数 |
| `success` | `Boolean` | 是否成功 |
| `error_msg` | `Text` | 错误信息 |
| `sync_time` | `DateTime` | 实际同步时间 |

### 4.5 `metadata.sync_task_log`

用途：

- 整体同步任务汇总日志

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `task_id` | `String(64)` | 任务 ID |
| `task_name` | `String(100)` | 任务名称 |
| `status` | `String(20)` | 状态 |
| `total_stocks` | `Integer` | 计划处理股票数 |
| `success_count` | `Integer` | 成功数 |
| `failed_count` | `Integer` | 失败数 |
| `skipped_count` | `Integer` | 跳过数 |
| `total_records` | `Integer` | 同步总记录数 |
| `failed_codes` | `JSONB` | 失败股票列表 |
| `error_msg` | `Text` | 错误信息 |
| `start_time` | `DateTime` | 开始时间 |
| `end_time` | `DateTime` | 结束时间 |

### 4.6 `metadata.optimize_history`

用途：

- ClickHouse `OPTIMIZE` 操作历史

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 主键 |
| `table_name` | `String(50)` | 被优化表名 |
| `partition` | `String(50)` | 分区名 |
| `parts_before` | `Integer` | 优化前分片数 |
| `parts_after` | `Integer` | 优化后分片数 |
| `elapsed_seconds` | `Float` | 耗时 |
| `optimize_time` | `DateTime` | 优化时间 |

### 4.7 `metadata.data_quality_log`

用途：

- 数据质量巡检日志

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 主键 |
| `check_date` | `Date` | 检查日期 |
| `overall_score` | `Float` | 总体质量评分 |
| `status` | `String(20)` | 状态 |
| `trading_days_completeness` | `Float` | 交易日覆盖完整度 |
| `data_reasonable` | `Boolean` | 数据是否合理 |
| `adjustflag_consistent` | `Boolean` | 复权标记是否一致 |
| `details` | `JSON` | 详细检查结果 |
| `check_time` | `DateTime` | 检查时间 |

### 4.8 `metadata.api_call_log`

用途：

- 记录 API 明细调用耗时与结果

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `BigInteger` | 主键 |
| `call_time` | `DateTime` | 调用时间 |
| `api_type` | `String(50)` | API 类型 |
| `code` | `String(20)` | 股票代码 |
| `success` | `Boolean` | 是否成功 |
| `response_time_ms` | `Float` | 响应耗时 |
| `error_msg` | `Text` | 错误信息 |

### 4.9 `metadata.system_config`

用途：

- 系统配置键值表

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `key` | `String(100)` | 配置键，主键 |
| `value` | `Text` | 配置值 |
| `description` | `Text` | 配置说明 |
| `update_time` | `DateTime` | 更新时间 |

### 4.10 `users.users`

用途：

- 用户主表

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 用户 ID |
| `username` | `String(50)` | 用户名 |
| `email` | `String(100)` | 邮箱 |
| `password_hash` | `String(255)` | bcrypt 哈希后的密码 |
| `full_name` | `String(100)` | 显示名称 |
| `phone` | `String(20)` | 手机号 |
| `status` | `String(20)` | 状态，如 `active` |
| `role` | `String(20)` | 角色，如 `user` / `admin` / `superadmin` |
| `created_at` | `DateTime` | 创建时间 |
| `updated_at` | `DateTime` | 更新时间 |
| `last_login_at` | `DateTime` | 最近登录时间 |

### 4.11 `users.user_sessions`

用途：

- 用户会话表

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 主键 |
| `user_id` | `Integer` | 用户 ID |
| `session_token` | `String(255)` | 会话 Token |
| `ip_address` | `String(50)` | 登录 IP |
| `user_agent` | `Text` | UA |
| `expires_at` | `DateTime` | 过期时间 |
| `created_at` | `DateTime` | 创建时间 |

### 4.12 `users.user_permissions`

用途：

- 用户权限明细

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `Integer` | 主键 |
| `user_id` | `Integer` | 用户 ID |
| `permission` | `String(50)` | 权限项 |
| `resource` | `String(50)` | 资源对象 |
| `granted_at` | `DateTime` | 授权时间 |
| `granted_by` | `Integer` | 授权人 ID |

### 4.13 `scan_log`（public）

用途：

- 市场扫描执行日志

来源：

- `backend/core/market_scanner/schema.py`
- `backend/migrations/postgresql/001_rename_strategy_to_method.sql`

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `scan_id` | `VARCHAR(36)` | 扫描 ID，主键 |
| `method_id` | `VARCHAR(50)` | 扫描方法 ID |
| `start_time` | `TIMESTAMP` | 开始时间 |
| `end_time` | `TIMESTAMP` | 结束时间 |
| `stock_count` | `INTEGER` | 命中股票数 |
| `status` | `VARCHAR(20)` | 扫描状态 |
| `error_message` | `TEXT` | 错误信息 |

### 4.14 `backtest_tasks`（public）

用途：

- 参数训练 / 回测任务队列
- 后台“参数训练任务列表”主要依赖此表

来源：

- `backend/scripts/migrations/create_backtest_tasks_table.sql`
- `backend/core/daos/backtest_tasks.py`

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `SERIAL` | 任务 ID |
| `stock_code` | `VARCHAR(20)` | 股票代码 |
| `stock_name` | `VARCHAR(100)` | 股票名称 |
| `task_type` | `VARCHAR(20)` | 任务类型，如 `manual` / `scheduled` |
| `priority` | `INTEGER` | 优先级，越大越优先 |
| `status` | `VARCHAR(20)` | 任务状态，如 `pending` / `running` / `failed` / `completed` |
| `mode` | `VARCHAR(...)` | 运行模式，DAO 当前在使用，如 `balanced` |
| `iteration_count` | `INTEGER` | 已迭代次数 |
| `max_iterations` | `INTEGER` | 最大迭代次数 |
| `current_stage` | `INTEGER` | 当前阶段 |
| `stage_progress` | `JSONB` | 各阶段进度 |
| `result_params` | `JSONB` | 训练结果参数 |
| `error_message` | `TEXT` | 错误信息 |
| `created_at` | `TIMESTAMP` | 创建时间 |
| `started_at` | `TIMESTAMP` | 开始时间 |
| `completed_at` | `TIMESTAMP` | 完成时间 |

重要说明：

- 该表的 SQL migration 初版未显式包含 `mode` 字段，但 DAO 当前读写已依赖 `mode`
- 如果现场库缺少 `mode` 字段，需补 migration 或手工 `ALTER TABLE`

### 4.15 `global_stock_params`（public）

用途：

- 每只股票的全局最优参数缓存表

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `SERIAL` | 主键 |
| `stock_code` | `VARCHAR(20)` | 股票代码，唯一 |
| `stock_name` | `VARCHAR(100)` | 股票名称 |
| `optimization_status` | `VARCHAR(20)` | 参数优化状态 |
| `optimized_at` | `TIMESTAMP` | 最近优化时间 |
| `next_scheduled_run` | `TIMESTAMP` | 下次调度时间 |
| `optimal_params` | `JSONB` | 最优参数 |
| `backtest_metrics` | `JSONB` | 回测指标 |
| `param_version` | `INTEGER` | 参数版本 |
| `is_stale` | `BOOLEAN` | 是否过期 |
| `created_at` | `TIMESTAMP` | 创建时间 |
| `updated_at` | `TIMESTAMP` | 更新时间 |

### 4.16 `holdings`（public）

用途：

- 当前持仓表

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `SERIAL` | 主键 |
| `stock_code` | `VARCHAR(20)` | 股票代码 |
| `stock_name` | `VARCHAR(100)` | 股票名称 |
| `quantity` | `INTEGER` | 总持仓数量 |
| `available_quantity` | `INTEGER` | 可卖数量 |
| `frozen_quantity` | `INTEGER` | 冻结数量 |
| `avg_cost` | `DECIMAL(10,4)` | 持仓均价 |
| `total_cost` | `DECIMAL(15,4)` | 持仓总成本 |
| `entry_date` | `TIMESTAMP` | 建仓时间 |
| `latest_price` | `DECIMAL(10,4)` | 最新价 |
| `market_value` | `DECIMAL(15,4)` | 市值 |
| `unrealized_pnl` | `DECIMAL(15,4)` | 浮盈亏 |
| `unrealized_pnl_pct` | `DECIMAL(8,4)` | 浮盈亏比例 |
| `status` | `VARCHAR(20)` | 持仓状态，如 `holding` / `sold` |
| `strategy_params` | `JSONB` | 策略参数 |
| `stop_loss_price` | `DECIMAL(10,4)` | 止损价 |
| `take_profit_price` | `DECIMAL(10,4)` | 止盈价 |
| `max_profit_pct` | `DECIMAL(8,4)` | 历史最大盈利比例 |
| `user_id` | `INTEGER` | 所属用户 ID，后续迁移补充 |
| `created_at` | `TIMESTAMP` | 创建时间 |
| `updated_at` | `TIMESTAMP` | 更新时间 |

### 4.17 `trading_signals`（public）

用途：

- 买卖信号流水

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `SERIAL` | 主键 |
| `signal_type` | `VARCHAR(20)` | 信号类型 |
| `stock_code` | `VARCHAR(20)` | 股票代码 |
| `stock_name` | `VARCHAR(100)` | 股票名称 |
| `trigger_price` | `DECIMAL(10,4)` | 触发价格 |
| `signal_strength` | `INTEGER` | 信号强度 |
| `trigger_reasons` | `JSONB` | 触发原因列表 |
| `position_advice` | `JSONB` | 仓位建议 |
| `expected_return` | `DECIMAL(8,4)` | 预期收益 |
| `risk_level` | `VARCHAR(10)` | 风险等级 |
| `is_active` | `BOOLEAN` | 是否仍有效 |
| `triggered_at` | `TIMESTAMP` | 触发时间 |
| `executed_at` | `TIMESTAMP` | 执行时间 |
| `executed_price` | `DECIMAL(10,4)` | 实际执行价 |
| `executed_quantity` | `INTEGER` | 实际执行数量 |
| `created_at` | `TIMESTAMP` | 创建时间 |

### 4.18 `trade_records`（public）

用途：

- 成交记录流水

字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `SERIAL` | 主键 |
| `trade_type` | `VARCHAR(10)` | 交易类型，如 `buy` / `sell` |
| `stock_code` | `VARCHAR(20)` | 股票代码 |
| `stock_name` | `VARCHAR(100)` | 股票名称 |
| `executed_price` | `DECIMAL(10,4)` | 成交价 |
| `executed_quantity` | `INTEGER` | 成交数量 |
| `suggested_price` | `DECIMAL(10,4)` | 建议价 |
| `suggested_quantity` | `INTEGER` | 建议数量 |
| `total_amount` | `DECIMAL(15,4)` | 成交总金额 |
| `fees` | `DECIMAL(10,4)` | 费用 |
| `cost_basis` | `DECIMAL(15,4)` | 成本基准 |
| `realized_pnl` | `DECIMAL(15,4)` | 已实现盈亏 |
| `signal_id` | `INTEGER` | 对应信号 ID |
| `trigger_reasons` | `JSONB` | 触发原因 |
| `executed_at` | `TIMESTAMP` | 成交时间 |
| `created_at` | `TIMESTAMP` | 创建时间 |

---

## 5. 当前库结构中的注意事项

### 5.1 ClickHouse 初始化脚本与核心客户端定义不完全一致

主要差异：

- `scripts/init_clickhouse.py` 中 `stock_minute5` 使用 `date + time`
- `backend/core/clickhouse_client.py` 中 `stock_minute5` 使用 `datetime`

建议：

- 以 `backend/core/clickhouse_client.py` 为当前运行时准
- 盘点现场库结构时，优先执行 `DESCRIBE TABLE stock_minute5`

### 5.2 PostgreSQL ORM 与 migration 并存

当前存在两套定义来源：

- SQLAlchemy ORM：更偏元数据、用户体系
- SQL migration：更偏任务、持仓、交易、参数训练

建议：

- 新接入方若做数据消费，先以现场数据库 `information_schema.columns` 为准
- 文档层面可把 ORM 视为“应用模型”，migration 视为“实际落库补充”

### 5.3 `business` schema 与 `public` 表并存风险

代码里存在：

- `business.user_watchlist`
- `business.trading_strategies`
- `business.trading_signals`
- `business.mock_orders`

但 migration 中很多业务表直接落在 `public`：

- `holdings`
- `trading_signals`
- `trade_records`
- `backtest_tasks`
- `global_stock_params`

建议：

- 做 DBA 盘点时先确认线上实际 schema 分布
- 后续可统一到 `business` 或统一到 `public`，避免双轨维护

---

## 6. 常用巡检 SQL

### 6.1 ClickHouse

```sql
SHOW TABLES FROM stock_data;
```

```sql
DESCRIBE TABLE stock_data.stock_daily;
```

```sql
SELECT code, max(date) AS latest_date
FROM stock_data.stock_daily
GROUP BY code
ORDER BY latest_date DESC
LIMIT 20;
```

```sql
SELECT date, is_trading_day
FROM stock_data.trading_calendar
ORDER BY date DESC
LIMIT 20;
```

### 6.2 PostgreSQL

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;
```

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'backtest_tasks'
ORDER BY ordinal_position;
```

```sql
SELECT id, stock_code, status, priority, created_at
FROM backtest_tasks
ORDER BY created_at DESC
LIMIT 20;
```

```sql
SELECT scan_id, method_id, status, start_time, end_time, stock_count
FROM scan_log
ORDER BY start_time DESC
LIMIT 20;
```

---

## 7. 建议的现场核对清单

上线或排障时建议优先核对：

1. `stock_daily` 最新交易日是否为当前应有交易日
2. `trading_calendar` 是否已补到今天
3. `backtest_tasks` 是否包含 `mode` 字段
4. `global_stock_params` 是否有过期积压
5. `scan_log` 最近扫描是否成功
6. `holdings` 是否已包含 `user_id`


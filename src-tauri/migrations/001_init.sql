-- Watch Ticket 初始表结构

-- 订阅的股票
CREATE TABLE IF NOT EXISTS subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL UNIQUE,           -- MARKET:CODE
    name          TEXT,
    market        TEXT NOT NULL,                  -- SH/SZ/BJ/HK/US
    kline_periods TEXT NOT NULL DEFAULT '1d',     -- 逗号分隔的周期
    sort_order    INTEGER NOT NULL DEFAULT 0,
    added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分时快照（1 分钟粒度）
CREATE TABLE IF NOT EXISTS intraday_snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol    TEXT NOT NULL,
    ts        TEXT NOT NULL,                     -- ISO 时间
    price     REAL NOT NULL,
    avg_price REAL,
    volume    REAL,
    amount    REAL,
    UNIQUE(symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_intraday_symbol_ts ON intraday_snapshots(symbol, ts);

-- K 线（各周期共表）
CREATE TABLE IF NOT EXISTS klines (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol  TEXT NOT NULL,
    period  TEXT NOT NULL,                       -- 1m/5m/15m/30m/60m/1d/1w/1M
    ts      TEXT NOT NULL,
    open    REAL NOT NULL,
    high    REAL NOT NULL,
    low     REAL NOT NULL,
    close   REAL NOT NULL,
    volume  REAL,
    amount  REAL,
    dif     REAL,
    dea     REAL,
    macd    REAL,
    UNIQUE(symbol, period, ts)
);
CREATE INDEX IF NOT EXISTS idx_kline_lookup ON klines(symbol, period, ts);

-- 告警记录（P6 用）
CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    period       TEXT NOT NULL,
    ts           TEXT NOT NULL,
    alert_type   TEXT NOT NULL,                  -- golden_cross / dead_cross
    dif          REAL,
    dea          REAL,
    price        REAL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

-- 配置
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 默认配置项
INSERT OR IGNORE INTO settings(key, value) VALUES
    ('intraday_interval_sec',   '5'),
    ('kline_1m_interval_sec',   '30'),
    ('kline_5m_interval_sec',   '60'),
    ('kline_daily_interval_sec','300'),
    ('macd_fast',   '12'),
    ('macd_slow',   '26'),
    ('macd_signal', '9'),
    ('data_retention_days', '30');

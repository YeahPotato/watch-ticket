-- 给告警加 (symbol, period, ts, alert_type) 唯一约束，保证同一根 K 线的同类型 cross 只入库一次。
--
-- SQLite 不支持直接 ALTER TABLE ADD CONSTRAINT，用"新表 + 拷贝 + 换名"的经典做法。

CREATE TABLE IF NOT EXISTS alerts_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    period       TEXT NOT NULL,
    ts           TEXT NOT NULL,
    alert_type   TEXT NOT NULL,
    dif          REAL,
    dea          REAL,
    price        REAL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(symbol, period, ts, alert_type)
);

INSERT OR IGNORE INTO alerts_new
    (id, symbol, period, ts, alert_type, dif, dea, price, acknowledged, created_at)
SELECT
     id, symbol, period, ts, alert_type, dif, dea, price, acknowledged, created_at
FROM alerts;

DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol, period);

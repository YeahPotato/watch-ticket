//! SQLite CRUD 层。
//!
//! 只写和"业务相关"的库操作；migration 和连接池管理在 db.rs。

use sqlx::{Row, SqlitePool};

use crate::error::AppResult;
use crate::models::{Alert, IntradayPoint, KlinePoint, Quote, Subscription};

// ============ 订阅 ============

pub async fn list_subscriptions(pool: &SqlitePool) -> AppResult<Vec<Subscription>> {
    let rows = sqlx::query(
        r#"SELECT id, symbol, name, market, kline_periods, sort_order, added_at, note
             FROM subscriptions
             ORDER BY sort_order ASC, id ASC"#,
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(Subscription {
            id: r.get::<i64, _>("id"),
            symbol: r.get::<String, _>("symbol"),
            name: r.try_get::<Option<String>, _>("name").unwrap_or(None),
            market: r.get::<String, _>("market"),
            kline_periods: r.get::<String, _>("kline_periods"),
            sort_order: r.get::<i64, _>("sort_order"),
            added_at: r.get::<String, _>("added_at"),
            note: r.try_get::<String, _>("note").unwrap_or_default(),
        });
    }
    Ok(out)
}

pub async fn upsert_subscription(
    pool: &SqlitePool,
    symbol: &str,
    name: Option<&str>,
    market: &str,
    kline_periods: &str,
) -> AppResult<Subscription> {
    sqlx::query(
        r#"INSERT INTO subscriptions(symbol, name, market, kline_periods)
           VALUES(?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
               name = COALESCE(excluded.name, subscriptions.name),
               market = excluded.market,
               kline_periods = excluded.kline_periods"#,
    )
    .bind(symbol)
    .bind(name)
    .bind(market)
    .bind(kline_periods)
    .execute(pool)
    .await?;

    get_subscription(pool, symbol)
        .await?
        .ok_or_else(|| crate::error::AppError::msg("插入后查不到订阅"))
}

pub async fn get_subscription(
    pool: &SqlitePool,
    symbol: &str,
) -> AppResult<Option<Subscription>> {
    let row = sqlx::query(
        r#"SELECT id, symbol, name, market, kline_periods, sort_order, added_at, note
             FROM subscriptions WHERE symbol = ?"#,
    )
    .bind(symbol)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| Subscription {
        id: r.get::<i64, _>("id"),
        symbol: r.get::<String, _>("symbol"),
        name: r.try_get::<Option<String>, _>("name").unwrap_or(None),
        market: r.get::<String, _>("market"),
        kline_periods: r.get::<String, _>("kline_periods"),
        sort_order: r.get::<i64, _>("sort_order"),
        added_at: r.get::<String, _>("added_at"),
        note: r.try_get::<String, _>("note").unwrap_or_default(),
    }))
}

pub async fn delete_subscription(pool: &SqlitePool, symbol: &str) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM subscriptions WHERE symbol = ?")
        .bind(symbol)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn update_periods(
    pool: &SqlitePool,
    symbol: &str,
    kline_periods: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE subscriptions SET kline_periods = ? WHERE symbol = ?")
        .bind(kline_periods)
        .bind(symbol)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_note(
    pool: &SqlitePool,
    symbol: &str,
    note: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE subscriptions SET note = ? WHERE symbol = ?")
        .bind(note)
        .bind(symbol)
        .execute(pool)
        .await?;
    Ok(())
}

// ============ K 线 ============

pub async fn upsert_klines(
    pool: &SqlitePool,
    symbol: &str,
    period: &str,
    points: &[KlinePoint],
) -> AppResult<()> {
    if points.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for p in points {
        sqlx::query(
            r#"INSERT INTO klines(symbol, period, ts, open, high, low, close, volume, amount, dif, dea, macd)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(symbol, period, ts) DO UPDATE SET
                   open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                   volume=excluded.volume, amount=excluded.amount,
                   dif=COALESCE(excluded.dif, klines.dif),
                   dea=COALESCE(excluded.dea, klines.dea),
                   macd=COALESCE(excluded.macd, klines.macd)"#,
        )
        .bind(symbol)
        .bind(period)
        .bind(&p.ts)
        .bind(p.open)
        .bind(p.high)
        .bind(p.low)
        .bind(p.close)
        .bind(p.volume)
        .bind(p.amount)
        .bind(p.dif)
        .bind(p.dea)
        .bind(p.macd)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn get_klines(
    pool: &SqlitePool,
    symbol: &str,
    period: &str,
    limit: i64,
) -> AppResult<Vec<KlinePoint>> {
    // 取最近 N 根，然后倒序返回（按时间升序）
    let rows = sqlx::query(
        r#"SELECT * FROM (
               SELECT ts, open, high, low, close, volume, amount, dif, dea, macd
                 FROM klines WHERE symbol = ? AND period = ?
                 ORDER BY ts DESC LIMIT ?
           ) ORDER BY ts ASC"#,
    )
    .bind(symbol)
    .bind(period)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| KlinePoint {
            ts: r.get::<String, _>("ts"),
            open: r.get::<f64, _>("open"),
            high: r.get::<f64, _>("high"),
            low: r.get::<f64, _>("low"),
            close: r.get::<f64, _>("close"),
            volume: r.try_get::<Option<f64>, _>("volume").unwrap_or(None),
            amount: r.try_get::<Option<f64>, _>("amount").unwrap_or(None),
            dif: r.try_get::<Option<f64>, _>("dif").unwrap_or(None),
            dea: r.try_get::<Option<f64>, _>("dea").unwrap_or(None),
            macd: r.try_get::<Option<f64>, _>("macd").unwrap_or(None),
        })
        .collect())
}

// ============ 分时 ============

pub async fn replace_intraday(
    pool: &SqlitePool,
    symbol: &str,
    points: &[IntradayPoint],
) -> AppResult<()> {
    if points.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for p in points {
        sqlx::query(
            r#"INSERT INTO intraday_snapshots(symbol, ts, price, avg_price, volume, amount)
               VALUES(?, ?, ?, ?, ?, ?)
               ON CONFLICT(symbol, ts) DO UPDATE SET
                   price=excluded.price, avg_price=excluded.avg_price,
                   volume=excluded.volume, amount=excluded.amount"#,
        )
        .bind(symbol)
        .bind(&p.ts)
        .bind(p.price)
        .bind(p.avg_price)
        .bind(p.volume)
        .bind(p.amount)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn get_intraday(pool: &SqlitePool, symbol: &str) -> AppResult<Vec<IntradayPoint>> {
    let rows = sqlx::query(
        r#"SELECT ts, price, avg_price, volume, amount
             FROM intraday_snapshots WHERE symbol = ?
             ORDER BY ts ASC"#,
    )
    .bind(symbol)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| IntradayPoint {
            ts: r.get::<String, _>("ts"),
            price: r.get::<f64, _>("price"),
            avg_price: r.try_get::<Option<f64>, _>("avg_price").unwrap_or(None),
            volume: r.try_get::<Option<f64>, _>("volume").unwrap_or(None),
            amount: r.try_get::<Option<f64>, _>("amount").unwrap_or(None),
        })
        .collect())
}

// ============ Quote 缓存（用 intraday 最后一点 + subscriptions 提供名字） ============

#[allow(dead_code)]
pub async fn get_latest_quote(pool: &SqlitePool, symbol: &str) -> AppResult<Option<Quote>> {
    let row = sqlx::query(
        r#"SELECT s.name, i.ts, i.price
             FROM subscriptions s
             LEFT JOIN intraday_snapshots i ON i.symbol = s.symbol
             WHERE s.symbol = ?
             ORDER BY i.ts DESC LIMIT 1"#,
    )
    .bind(symbol)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| Quote {
        symbol: symbol.to_string(),
        name: r.try_get::<Option<String>, _>("name").unwrap_or(None),
        price: r.try_get::<Option<f64>, _>("price").unwrap_or(None),
        open: None,
        high: None,
        low: None,
        prev_close: None,
        change: None,
        change_pct: None,
        volume: None,
        amount: None,
        ts: r.try_get::<Option<String>, _>("ts").unwrap_or(None),
    }))
}

// ============ 设置 ============

pub async fn list_settings(
    pool: &SqlitePool,
) -> AppResult<std::collections::HashMap<String, String>> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await?;
    let mut map = std::collections::HashMap::new();
    for r in rows {
        map.insert(r.get::<String, _>("key"), r.get::<String, _>("value"));
    }
    Ok(map)
}

pub async fn get_setting(pool: &SqlitePool, key: &str) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

pub async fn upsert_setting(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    sqlx::query(
        r#"INSERT INTO settings(key, value) VALUES(?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

// ============ 告警 ============

fn row_to_alert(r: &sqlx::sqlite::SqliteRow) -> Alert {
    Alert {
        id: r.get::<i64, _>("id"),
        symbol: r.get::<String, _>("symbol"),
        period: r.get::<String, _>("period"),
        ts: r.get::<String, _>("ts"),
        alert_type: r.get::<String, _>("alert_type"),
        alert_kind: r
            .try_get::<String, _>("alert_kind")
            .unwrap_or_default(),
        dif: r.try_get::<Option<f64>, _>("dif").unwrap_or(None),
        dea: r.try_get::<Option<f64>, _>("dea").unwrap_or(None),
        price: r.try_get::<Option<f64>, _>("price").unwrap_or(None),
        acknowledged: r.get::<i64, _>("acknowledged") != 0,
        created_at: r.get::<String, _>("created_at"),
    }
}

/// 批量插入告警。使用 UNIQUE(symbol, period, ts, alert_type) 约束去重（INSERT OR IGNORE）。
/// 返回真正被插入的行（用于事件推送）。
pub async fn insert_alerts_if_new(
    pool: &SqlitePool,
    rows: &[Alert],
) -> AppResult<Vec<Alert>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut inserted = Vec::new();
    let mut tx = pool.begin().await?;
    for a in rows {
        let res = sqlx::query(
            r#"INSERT OR IGNORE INTO alerts(symbol, period, ts, alert_type, alert_kind, dif, dea, price)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&a.symbol)
        .bind(&a.period)
        .bind(&a.ts)
        .bind(&a.alert_type)
        .bind(&a.alert_kind)
        .bind(a.dif)
        .bind(a.dea)
        .bind(a.price)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() > 0 {
            let id = res.last_insert_rowid();
            let row = sqlx::query(
                r#"SELECT id, symbol, period, ts, alert_type, alert_kind, dif, dea, price, acknowledged, created_at
                     FROM alerts WHERE id = ?"#,
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            inserted.push(row_to_alert(&row));
        }
    }
    tx.commit().await?;
    Ok(inserted)
}

pub async fn list_alerts(
    pool: &SqlitePool,
    limit: i64,
    only_unack: bool,
) -> AppResult<Vec<Alert>> {
    let sql = if only_unack {
        r#"SELECT id, symbol, period, ts, alert_type, alert_kind, dif, dea, price, acknowledged, created_at
             FROM alerts WHERE acknowledged = 0
             ORDER BY id DESC LIMIT ?"#
    } else {
        r#"SELECT id, symbol, period, ts, alert_type, alert_kind, dif, dea, price, acknowledged, created_at
             FROM alerts ORDER BY id DESC LIMIT ?"#
    };
    let rows = sqlx::query(sql).bind(limit).fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_alert).collect())
}

pub async fn ack_alert(pool: &SqlitePool, id: i64) -> AppResult<u64> {
    let res = sqlx::query("UPDATE alerts SET acknowledged = 1 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn ack_all_alerts(pool: &SqlitePool) -> AppResult<u64> {
    let res = sqlx::query("UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0")
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn count_unack(pool: &SqlitePool) -> AppResult<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS c FROM alerts WHERE acknowledged = 0")
        .fetch_one(pool)
        .await?;
    Ok(row.get::<i64, _>("c"))
}

pub async fn clear_alerts_older_than(pool: &SqlitePool, days: i64) -> AppResult<u64> {
    let res = sqlx::query(
        "DELETE FROM alerts WHERE created_at < datetime('now', ?)",
    )
    .bind(format!("-{} days", days.max(0)))
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

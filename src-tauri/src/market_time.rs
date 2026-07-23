//! 三大市场交易时段判断。
//!
//! 简化版：
//!   - A 股（SH/SZ/BJ）：Asia/Shanghai 09:30-11:30 & 13:00-15:00，周一~周五
//!   - 港股（HK）：Asia/Hong_Kong 09:30-12:00 & 13:00-16:00
//!   - 美股（US）：America/New_York 09:30-16:00（夏令时由 chrono-tz 自动处理）
//!
//! 不包含节假日排除（P7 可接入交易日历）。

use chrono::{Datelike, NaiveTime, Weekday};
use chrono_tz::Tz;

fn is_weekday(wd: Weekday) -> bool {
    !matches!(wd, Weekday::Sat | Weekday::Sun)
}

fn in_session(now: NaiveTime, sessions: &[(NaiveTime, NaiveTime)]) -> bool {
    sessions.iter().any(|(s, e)| now >= *s && now < *e)
}

pub fn is_market_open(market: &str) -> bool {
    let now_utc = chrono::Utc::now();
    match market {
        "SH" | "SZ" | "BJ" => {
            let tz: Tz = chrono_tz::Asia::Shanghai;
            let local = now_utc.with_timezone(&tz);
            if !is_weekday(local.weekday()) {
                return false;
            }
            let sessions = [
                (
                    NaiveTime::from_hms_opt(9, 30, 0).unwrap(),
                    NaiveTime::from_hms_opt(11, 30, 0).unwrap(),
                ),
                (
                    NaiveTime::from_hms_opt(13, 0, 0).unwrap(),
                    NaiveTime::from_hms_opt(15, 0, 0).unwrap(),
                ),
            ];
            in_session(local.time(), &sessions)
        }
        "HK" => {
            let tz: Tz = chrono_tz::Asia::Hong_Kong;
            let local = now_utc.with_timezone(&tz);
            if !is_weekday(local.weekday()) {
                return false;
            }
            let sessions = [
                (
                    NaiveTime::from_hms_opt(9, 30, 0).unwrap(),
                    NaiveTime::from_hms_opt(12, 0, 0).unwrap(),
                ),
                (
                    NaiveTime::from_hms_opt(13, 0, 0).unwrap(),
                    NaiveTime::from_hms_opt(16, 0, 0).unwrap(),
                ),
            ];
            in_session(local.time(), &sessions)
        }
        "US" => {
            let tz: Tz = chrono_tz::America::New_York;
            let local = now_utc.with_timezone(&tz);
            if !is_weekday(local.weekday()) {
                return false;
            }
            let sessions = [(
                NaiveTime::from_hms_opt(9, 30, 0).unwrap(),
                NaiveTime::from_hms_opt(16, 0, 0).unwrap(),
            )];
            in_session(local.time(), &sessions)
        }
        _ => false,
    }
}

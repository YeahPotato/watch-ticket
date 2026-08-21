//! 封装对 Python sidecar 的 HTTP 调用。

use std::time::Duration;

use reqwest::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::{ApiEnvelope, DividendInfo, IntradayPoint, KlinePoint, Quote, SearchItem};

pub struct AkClient {
    base: String,
    http: Client,
}

impl AkClient {
    pub fn new(port: u16) -> AppResult<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(3))
            .build()?;
        Ok(Self {
            base: format!("http://127.0.0.1:{}", port),
            http,
        })
    }

    async fn get_envelope<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> AppResult<T> {
        let url = format!("{}{}", self.base, path);
        let resp = self.http.get(&url).query(query).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(AppError::Sidecar(format!(
                "HTTP {} on {} body: {}",
                status, path, text
            )));
        }
        let env: ApiEnvelope<T> = serde_json::from_str(&text)
            .map_err(|e| AppError::Sidecar(format!("响应解析失败 {}: {}", path, e)))?;
        if env.code != 0 {
            return Err(AppError::SidecarBusiness {
                code: env.code,
                msg: env.msg,
            });
        }
        env.data
            .ok_or_else(|| AppError::Sidecar(format!("{} 返回 data 为空", path)))
    }

    pub async fn health(&self) -> AppResult<Value> {
        self.get_envelope::<Value>("/health", &[]).await
    }

    pub async fn get_quote(&self, symbol: &str) -> AppResult<Quote> {
        self.get_envelope::<Quote>("/quote", &[("symbol", symbol.to_string())])
            .await
    }

    #[allow(dead_code)]
    pub async fn get_quotes(&self, symbols: &[String]) -> AppResult<Vec<Quote>> {
        let joined = symbols.join(",");
        self.get_envelope::<Vec<Quote>>("/quotes", &[("symbols", joined)])
            .await
    }

    #[allow(dead_code)]
    pub async fn get_intraday(&self, symbol: &str) -> AppResult<Vec<IntradayPoint>> {
        self.get_envelope::<Vec<IntradayPoint>>("/intraday", &[("symbol", symbol.to_string())])
            .await
    }

    pub async fn get_kline(
        &self,
        symbol: &str,
        period: &str,
        limit: i64,
    ) -> AppResult<Vec<KlinePoint>> {
        self.get_envelope::<Vec<KlinePoint>>(
            "/kline",
            &[
                ("symbol", symbol.to_string()),
                ("period", period.to_string()),
                ("limit", limit.to_string()),
            ],
        )
        .await
    }

    pub async fn search(&self, keyword: &str, limit: i64) -> AppResult<Vec<SearchItem>> {
        self.get_envelope::<Vec<SearchItem>>(
            "/search",
            &[
                ("keyword", keyword.to_string()),
                ("limit", limit.to_string()),
            ],
        )
        .await
    }

    /// 获取指定 symbol 在过去 12 个月的分红汇总（TTM）。
    /// end_date 传 None 时 sidecar 会用"今天"作为默认。
    pub async fn get_dividend(
        &self,
        symbol: &str,
        end_date: Option<&str>,
    ) -> AppResult<DividendInfo> {
        let mut query: Vec<(&str, String)> = vec![("symbol", symbol.to_string())];
        if let Some(d) = end_date {
            query.push(("end_date", d.to_string()));
        }
        self.get_envelope::<DividendInfo>("/dividend", &query).await
    }
}

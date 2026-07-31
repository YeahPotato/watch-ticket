-- 004: 给 subscriptions 表加自由文本备注字段
-- 用于用户在量化分析 widget 里对每支股票写个人笔记（买入/卖出理由、目标价等）
ALTER TABLE subscriptions ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- 给 alerts 表加 alert_kind 字段（业务信号细分）
--
-- alert_kind 可能取值：
--   golden_entry        零轴附近水上金叉 → 建仓
--   golden_add          水上金叉（远离零轴）→ 加仓
--   golden_bounce       水下金叉 → 短线反弹（不新增底仓）
--   dead_reduce         水上死叉 → 减仓 / 做反 T
--   dead_risk           水下死叉 → 风险信号（禁止抄底）

ALTER TABLE alerts ADD COLUMN alert_kind TEXT NOT NULL DEFAULT '';

-- 为旧数据回填一个占位（'legacy'），前端可以识别为无细分类型
UPDATE alerts SET alert_kind = 'legacy' WHERE alert_kind = '';

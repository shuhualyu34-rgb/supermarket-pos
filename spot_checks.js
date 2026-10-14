import { createHash } from 'node:crypto';
import { transaction } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PLAN_SIZE = 10;
const selectionOrder = ['risk', 'risk', 'overdue', 'risk', 'rotation', 'risk', 'overdue', 'risk', 'rotation', 'overdue'];

function weekRange(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  const localDay = Date.UTC(value('year'), value('month') - 1, value('day'));
  const dayFromMonday = (new Date(localDay).getUTCDay() + 6) % 7;
  const monday = localDay - dayFromMonday * DAY_MS;
  return {
    weekStart: new Date(monday).toISOString().slice(0, 10),
    weekEnd: new Date(monday + 6 * DAY_MS).toISOString().slice(0, 10),
    from: new Date(monday - SHANGHAI_OFFSET_MS).toISOString(),
    until: new Date(monday + 7 * DAY_MS - SHANGHAI_OFFSET_MS).toISOString(),
    salesFrom: new Date(monday - 28 * DAY_MS - SHANGHAI_OFFSET_MS).toISOString(),
    differenceFrom: new Date(monday - 90 * DAY_MS - SHANGHAI_OFFSET_MS).toISOString(),
  };
}

function ensurePlanTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_spot_check_items (
      week_start TEXT NOT NULL,
      position INTEGER NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      reason TEXT NOT NULL,
      PRIMARY KEY (week_start, product_id),
      UNIQUE (week_start, position)
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_spot_check_product
      ON weekly_spot_check_items(product_id, week_start);
    CREATE INDEX IF NOT EXISTS idx_audit_stock_count_product
      ON audit_events(action, entity_type, entity_id, created_at);
  `);
}

function rotationKey(weekStart, productId) {
  return createHash('sha256').update(`${weekStart}:${productId}`).digest('hex');
}

function buildPlan(db, range) {
  const products = db.prepare(`SELECT id,stock_milli
    FROM products WHERE active=1 ORDER BY id`).all();
  if (!products.length) return [];

  const sales = new Map(db.prepare(`SELECT oi.product_id,
      COALESCE(SUM(oi.quantity_milli),0) AS quantity_milli,
      COALESCE(SUM(oi.line_cents),0) AS sales_cents
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.inventory_posted=1 AND o.created_at>=? AND o.created_at<?
    GROUP BY oi.product_id`).all(range.salesFrom, range.from).map((row) => [row.product_id, row]));
  const lastCounts = new Map(db.prepare(`SELECT entity_id AS product_id, MAX(created_at) AS last_count_at
    FROM audit_events WHERE action='STOCK_COUNTED' AND entity_type='product' AND created_at<?
    GROUP BY entity_id`).all(range.from).map((row) => [row.product_id, row.last_count_at]));
  const lastSuggested = new Map(db.prepare(`SELECT product_id, MAX(week_start) AS last_suggested
    FROM weekly_spot_check_items WHERE week_start<? GROUP BY product_id`).all(range.weekStart)
    .map((row) => [row.product_id, row.last_suggested]));
  const priorDifferences = new Map();
  for (const row of db.prepare(`SELECT entity_id AS product_id, details FROM audit_events
    WHERE action='STOCK_COUNTED' AND entity_type='product' AND created_at>=? AND created_at<?`)
    .all(range.differenceFrom, range.from)) {
    let difference = 0;
    try { difference = Math.abs(Number(JSON.parse(row.details).differenceMilli) || 0); }
    catch { /* Older audit details may not be JSON. */ }
    priorDifferences.set(row.product_id, (priorDifferences.get(row.product_id) || 0) + difference);
  }
  const adjustments = new Map(db.prepare(`SELECT product_id, SUM(ABS(delta_milli)) AS quantity_milli
    FROM inventory_events WHERE type='ADJUSTMENT' AND created_at>=? AND created_at<?
    GROUP BY product_id`).all(range.differenceFrom, range.from)
    .map((row) => [row.product_id, row.quantity_milli]));

  const candidates = products.map((product) => {
    const sold = sales.get(product.id);
    const salesCents = sold?.sales_cents || 0;
    const quantityMilli = sold?.quantity_milli || 0;
    const differenceMilli = priorDifferences.get(product.id) || 0;
    const adjustmentMilli = adjustments.get(product.id) || 0;
    const riskScore = (differenceMilli ? 45 + Math.min(35, differenceMilli / 1000) : 0)
      + (product.stock_milli < 0 ? 35 : 0)
      + Math.log1p(Math.max(0, salesCents) / 100) * 5
      + Math.log1p(Math.max(0, quantityMilli) / 1000) * 3
      + (adjustmentMilli ? 12 : 0);
    let riskReason = '重点抽检';
    if (differenceMilli) riskReason = '近三个月盘点有差异';
    else if (product.stock_milli < 0) riskReason = '账面库存为负';
    else if (salesCents || quantityMilli) riskReason = '近四周销量或销售额较高';
    else if (adjustmentMilli) riskReason = '近期有库存调整';
    return {
      id: product.id,
      riskScore,
      riskReason,
      lastCountAt: lastCounts.get(product.id) || null,
      lastSuggested: lastSuggested.get(product.id) || null,
      rotationKey: rotationKey(range.weekStart, product.id),
    };
  });

  const tie = (a, b) => a.rotationKey.localeCompare(b.rotationKey);
  const risk = [...candidates].sort((a, b) => b.riskScore - a.riskScore || tie(a, b));
  const overdue = [...candidates].sort((a, b) =>
    (a.lastCountAt || '').localeCompare(b.lastCountAt || '')
    || (a.lastSuggested || '').localeCompare(b.lastSuggested || '') || tie(a, b));
  const rotation = [...candidates].sort((a, b) =>
    (a.lastSuggested || '').localeCompare(b.lastSuggested || '') || tie(a, b));
  const lists = { risk, overdue, rotation };
  const selected = new Set();
  const plan = [];
  for (const category of selectionOrder) {
    const candidate = lists[category].find((item) => !selected.has(item.id));
    if (!candidate) break;
    selected.add(candidate.id);
    plan.push({
      productId: candidate.id,
      reason: category === 'risk' ? candidate.riskReason
        : category === 'overdue' ? candidate.lastCountAt ? '距上次盘点时间较久' : '尚未抽盘'
          : '轮换抽检',
    });
  }
  return plan;
}

export function weeklySpotChecks(db, requestedLimit = 10, at = new Date()) {
  const range = weekRange(at);
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(PLAN_SIZE, Math.max(1, Math.trunc(parsedLimit))) : PLAN_SIZE;
  ensurePlanTable(db);
  const saved = db.prepare('SELECT product_id FROM weekly_spot_check_items WHERE week_start=? LIMIT 1')
    .get(range.weekStart);
  if (!saved) {
    const plan = buildPlan(db, range);
    if (plan.length) transaction(db, () => {
      const insert = db.prepare(`INSERT INTO weekly_spot_check_items
        (week_start,position,product_id,reason) VALUES (?,?,?,?)`);
      plan.forEach((item, position) => insert.run(range.weekStart, position, item.productId, item.reason));
    });
  }
  const latestCounts = new Map(db.prepare(`SELECT entity_id AS product_id, MAX(created_at) AS counted_at
    FROM audit_events WHERE action='STOCK_COUNTED' AND entity_type='product'
      AND created_at>=? AND created_at<? GROUP BY entity_id`).all(range.from, range.until)
    .map((row) => [row.product_id, row.counted_at]));
  const lastCount = db.prepare(`SELECT created_at,details FROM audit_events
    WHERE action='STOCK_COUNTED' AND entity_type='product' AND entity_id=?
    ORDER BY created_at DESC LIMIT 1`);
  const items = db.prepare(`SELECT p.id,p.barcode,p.name,p.unit,p.stock_milli,s.reason
    FROM weekly_spot_check_items s JOIN products p ON p.id=s.product_id
    WHERE s.week_start=? ORDER BY s.position LIMIT ?`).all(range.weekStart, limit).map((row) => {
    const countedAt = latestCounts.get(row.id) || null;
    const previous = lastCount.get(row.id);
    let lastDifferenceMilli = null;
    if (previous) {
      try { lastDifferenceMilli = Number(JSON.parse(previous.details).differenceMilli) || 0; }
      catch { /* Keep missing old audit data unknown. */ }
    }
    return {
      id: row.id, barcode: row.barcode, name: row.name, unit: row.unit,
      stockMilli: row.stock_milli, reason: row.reason,
      completed: Boolean(countedAt), countedAt,
      lastCountAt: previous?.created_at || null, lastDifferenceMilli,
    };
  });
  return {
    weekStart: range.weekStart, weekEnd: range.weekEnd,
    target: items.length,
    completed: items.filter((item) => item.completed).length,
    pending: items.filter((item) => !item.completed),
    items,
  };
}

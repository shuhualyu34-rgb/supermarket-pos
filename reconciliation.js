import { AppError, audit, now } from './domain.js';
import { transaction } from './db.js';

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year').value}-${parts.find((part) => part.type === 'month').value}`;
}

function monthKeys() {
  const [year, month] = currentMonth().split('-').map(Number);
  return Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(year, month - 13 + index, 1)).toISOString().slice(0, 7));
}

function rangeFor(month) {
  if (!monthKeys().includes(month)) throw new AppError('只能查询最近 13 个月（含本月）');
  const [year, number] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(year, number - 1, 1, -8)).toISOString(),
    until: new Date(Date.UTC(year, number, 1, -8)).toISOString(),
    previous: new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7),
  };
}

function nonnegativeQuantity(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError(`${name}必须是非负整数（千分单位）`);
  return value;
}

export function saveMonthlyStockCounts(db, actorId, month, entries) {
  const { until } = rangeFor(month);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 5000) throw new AppError('一次录入 1–5000 种商品');
  const parsed = entries.map((entry, index) => {
    const barcode = String(entry?.barcode ?? '').trim();
    if (!barcode) throw new AppError(`第 ${index + 1} 行缺少条码`);
    const hasOpening = entry.openingMilli !== undefined;
    const hasClosing = entry.closingMilli !== undefined;
    if (!hasOpening && !hasClosing) throw new AppError(`第 ${index + 1} 行没有盘点数量`);
    return {
      barcode,
      opening: hasOpening ? nonnegativeQuantity(entry.openingMilli, '期初实盘') : null,
      closing: hasClosing ? nonnegativeQuantity(entry.closingMilli, '期末实盘') : null,
    };
  });
  if (new Set(parsed.map((entry) => entry.barcode)).size !== parsed.length) throw new AppError('盘点文件中有重复条码');
  return transaction(db, () => {
    let updated = 0;
    for (const entry of parsed) {
      const product = db.prepare('SELECT id,unit FROM products WHERE barcode=? AND created_at<?').get(entry.barcode, until);
      if (!product) throw new AppError(`条码 ${entry.barcode} 在该月尚未建档`);
      if (product.unit === 'piece' && ((entry.opening !== null && entry.opening % 1000) || (entry.closing !== null && entry.closing % 1000))) {
        throw new AppError(`条码 ${entry.barcode} 按件商品必须填整数`);
      }
      const old = db.prepare('SELECT opening_milli,closing_milli FROM monthly_stock_counts WHERE month=? AND product_id=?').get(month, product.id);
      const opening = entry.opening ?? old?.opening_milli ?? null;
      const closing = entry.closing ?? old?.closing_milli ?? null;
      if (old && old.opening_milli === opening && old.closing_milli === closing) continue;
      db.prepare(`INSERT INTO monthly_stock_counts(month,product_id,opening_milli,closing_milli,updated_at,actor_id)
        VALUES (?,?,?,?,?,?) ON CONFLICT(month,product_id) DO UPDATE SET
        opening_milli=excluded.opening_milli,closing_milli=excluded.closing_milli,
        updated_at=excluded.updated_at,actor_id=excluded.actor_id`).run(month, product.id, opening, closing, now(), actorId);
      audit(db, actorId, 'MONTHLY_STOCK_COUNT_SAVED', 'product', product.id, {
        month, barcode: entry.barcode, oldOpeningMilli: old?.opening_milli ?? null,
        oldClosingMilli: old?.closing_milli ?? null, openingMilli: opening, closingMilli: closing,
      });
      updated++;
    }
    return { updated };
  });
}

export function monthlyStockReconciliation(db, month) {
  const { from, until, previous } = rangeFor(month);
  const products = db.prepare('SELECT id,barcode,name,unit,created_at,active FROM products WHERE created_at<? ORDER BY name,barcode').all(until);
  const counts = new Map(db.prepare('SELECT * FROM monthly_stock_counts WHERE month=?').all(month).map((item) => [item.product_id, item]));
  const previousCounts = new Map(db.prepare('SELECT product_id,closing_milli FROM monthly_stock_counts WHERE month=?').all(previous).map((item) => [item.product_id, item.closing_milli]));
  const movements = new Map();
  for (const event of db.prepare(`SELECT product_id,type,COALESCE(SUM(delta_milli),0) AS quantity
    FROM inventory_events WHERE created_at>=? AND created_at<? GROUP BY product_id,type`).all(from, until)) {
    if (!movements.has(event.product_id)) movements.set(event.product_id, {});
    movements.get(event.product_id)[event.type] = event.quantity;
  }
  const rows = products.map((product) => {
    const count = counts.get(product.id);
    const movement = movements.get(product.id) || {};
    const opening = count?.opening_milli ?? previousCounts.get(product.id) ?? (product.created_at >= from ? 0 : null);
    const openingSource = count?.opening_milli != null ? 'manual' : previousCounts.has(product.id) && previousCounts.get(product.id) != null ? 'previous' : product.created_at >= from ? 'new' : null;
    const closing = count?.closing_milli ?? null;
    const received = (movement.PURCHASE_RECEIPT || 0) + (movement.OPENING || 0);
    const otherAdjustment = movement.ADJUSTMENT || 0;
    const systemOutbound = -(movement.SALE || 0) - (movement.PENDING_SALE || 0) - (movement.VOID_RESTORE || 0) - (movement.REFUND_RESTOCK || 0);
    const actualOutbound = opening === null || closing === null ? null : opening + received + otherAdjustment - closing;
    const difference = actualOutbound === null ? null : actualOutbound - systemOutbound;
    return {
      id: product.id, barcode: product.barcode, name: product.name, unit: product.unit, active: product.active,
      openingMilli: opening, openingSource, closingMilli: closing, receivedMilli: received,
      otherAdjustmentMilli: otherAdjustment, systemOutboundMilli: systemOutbound,
      actualOutboundMilli: actualOutbound, differenceMilli: difference,
    };
  });
  return {
    month, months: monthKeys(), rows,
    summary: {
      total: rows.length,
      ready: rows.filter((item) => item.differenceMilli !== null).length,
      missing: rows.filter((item) => item.differenceMilli > 0).length,
      surplus: rows.filter((item) => item.differenceMilli < 0).length,
    },
  };
}

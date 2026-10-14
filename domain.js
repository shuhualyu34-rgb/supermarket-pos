import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const now = () => new Date().toISOString();
const id = () => randomUUID();
const requireText = (value, label, max = 200) => {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new AppError(`${label}不能为空，且不能超过 ${max} 字`);
  return text;
};
const nonnegative = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError(`${label}必须是非负整数`);
  return value;
};
const positive = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(`${label}必须是正整数`);
  return value;
};
const oneOf = (value, values, label) => {
  if (!values.includes(value)) throw new AppError(`${label}无效`);
  return value;
};
const row = (db, sql, ...params) => db.prepare(sql).get(...params);
const rows = (db, sql, ...params) => db.prepare(sql).all(...params);
const run = (db, sql, ...params) => db.prepare(sql).run(...params);

export function audit(db, actorId, action, entityType, entityId, details = {}) {
  run(db, 'INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)', id(), actorId, action, entityType, entityId, JSON.stringify(details), now());
}

function exception(db, kind, severity, entityType, entityId, description) {
  const exceptionId = id();
  run(db, 'INSERT INTO exceptions(id,kind,severity,entity_type,entity_id,description,created_at) VALUES (?,?,?,?,?,?,?)', exceptionId, kind, severity, entityType, entityId, description, now());
  return exceptionId;
}

export function listProducts(db, query = '', limit = 80, includeCost = false) {
  const q = String(query).trim();
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 80));
  const columns = includeCost ? 'p.*,c.latest_cost_cents' : 'p.*';
  const source = includeCost ? 'products p LEFT JOIN product_costs c ON c.product_id=p.id' : 'products p';
  const items = q
    ? rows(db, `SELECT ${columns} FROM ${source} WHERE p.active=1 AND (p.barcode=? OR p.name LIKE ? OR p.barcode LIKE ?) ORDER BY CASE WHEN p.barcode=? THEN 0 ELSE 1 END, p.name LIMIT ?`, q, `%${q}%`, `%${q}%`, q, safeLimit)
    : rows(db, `SELECT ${columns} FROM ${source} WHERE p.active=1 ORDER BY p.name LIMIT ?`, safeLimit);
  const total = row(db, 'SELECT COUNT(*) AS count FROM products WHERE active=1').count;
  return { items, total };
}

export function updateProductCost(db, actorId, productId, costCents, sourceType, sourceId = null) {
  const cost = nonnegative(costCents, '进货成本');
  const previous = row(db, 'SELECT latest_cost_cents FROM product_costs WHERE product_id=?', productId)?.latest_cost_cents ?? null;
  if (previous === cost) return cost;
  const time = now();
  run(db, `INSERT INTO product_costs(product_id,latest_cost_cents,updated_at) VALUES (?,?,?)
    ON CONFLICT(product_id) DO UPDATE SET latest_cost_cents=excluded.latest_cost_cents,updated_at=excluded.updated_at`, productId, cost, time);
  run(db, 'INSERT INTO product_cost_history VALUES (?,?,?,?,?,?,?,?)', id(), productId, previous, cost, sourceType, sourceId, actorId, time);
  audit(db, actorId, 'PRODUCT_COST_UPDATED', 'product', productId, { previousCostCents: previous, costCents: cost, sourceType, sourceId });
  return cost;
}

export function saveProduct(db, actorId, input, productId = null) {
  const barcode = requireText(input.barcode, '条码', 64);
  const name = requireText(input.name, '商品名称', 120);
  const unit = oneOf(input.unit, ['piece', 'kg'], '单位');
  const price = nonnegative(input.priceCents, '售价');
  const cost = input.costCents === undefined || input.costCents === null ? null : nonnegative(input.costCents, '进货成本');
  const reason = requireText(input.reason || '商品资料维护', '变更原因', 200);
  return transaction(db, () => {
    const existing = productId ? row(db, 'SELECT * FROM products WHERE id=?', productId) : null;
    if (productId && !existing) throw new AppError('商品不存在', 404);
    if (existing && existing.unit !== unit) throw new AppError('已有商品不能直接更改计量单位，请新建条码并盘点旧库存');
    const product = productId || id();
    const time = now();
    if (existing) {
      run(db, 'UPDATE products SET barcode=?,name=?,unit=?,price_cents=?,active=?,updated_at=? WHERE id=?', barcode, name, unit, price, input.active === false ? 0 : 1, time, product);
      if (price !== existing.price_cents) run(db, 'INSERT INTO price_history VALUES (?,?,?,?,?,?,?)', id(), product, existing.price_cents, price, actorId, reason, time);
    } else {
      const stock = nonnegative(input.stockMilli ?? 0, '初始库存');
      run(db, 'INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)', product, barcode, name, unit, price, stock, 1, time, time);
      run(db, 'INSERT INTO price_history VALUES (?,?,?,?,?,?,?)', id(), product, null, price, actorId, reason, time);
      if (stock) run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), product, stock, 'OPENING', null, '初始库存', actorId, time);
    }
    if (cost !== null) updateProductCost(db, actorId, product, cost, 'MANUAL');
    audit(db, actorId, existing ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED', 'product', product, { barcode, name, unit, priceCents: price, reason });
    return row(db, 'SELECT p.*,c.latest_cost_cents FROM products p LEFT JOIN product_costs c ON c.product_id=p.id WHERE p.id=?', product);
  });
}

export function importProducts(db, actorId, inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 5000) throw new AppError('一次导入 1–5000 行商品');
  const parsed = inputs.map((input, index) => {
    try {
      return { barcode: requireText(input.barcode, '条码', 64), name: requireText(input.name, '商品名称', 120), unit: oneOf(input.unit, ['piece', 'kg'], '单位'), priceCents: nonnegative(input.priceCents, '售价'), stockMilli: nonnegative(input.stockMilli ?? 0, '初始库存'), costCents: input.costCents === undefined || input.costCents === null ? null : nonnegative(input.costCents, '进货成本') };
    } catch (error) { throw new AppError(`第 ${index + 1} 行：${error.message}`); }
  });
  if (new Set(parsed.map((item) => item.barcode)).size !== parsed.length) throw new AppError('导入文件中有重复条码');
  return transaction(db, () => {
    let created = 0;
    let updated = 0;
    for (const input of parsed) {
      const existing = row(db, 'SELECT * FROM products WHERE barcode=?', input.barcode);
      const time = now();
      if (existing) {
        if (existing.unit !== input.unit) throw new AppError(`条码 ${input.barcode} 的计量单位与现有商品不同，请先处理旧库存`);
        run(db, 'UPDATE products SET name=?,unit=?,price_cents=?,active=1,updated_at=? WHERE id=?', input.name, input.unit, input.priceCents, time, existing.id);
        if (existing.price_cents !== input.priceCents) run(db, 'INSERT INTO price_history VALUES (?,?,?,?,?,?,?)', id(), existing.id, existing.price_cents, input.priceCents, actorId, '批量导入', time);
        if (input.costCents !== null) updateProductCost(db, actorId, existing.id, input.costCents, 'IMPORT');
        updated++;
      } else {
        const productId = id();
        run(db, 'INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)', productId, input.barcode, input.name, input.unit, input.priceCents, input.stockMilli, 1, time, time);
        run(db, 'INSERT INTO price_history VALUES (?,?,?,?,?,?,?)', id(), productId, null, input.priceCents, actorId, '批量导入', time);
        if (input.stockMilli) run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), productId, input.stockMilli, 'OPENING', null, '批量导入初始库存', actorId, time);
        if (input.costCents !== null) updateProductCost(db, actorId, productId, input.costCents, 'IMPORT');
        created++;
      }
    }
    audit(db, actorId, 'PRODUCTS_IMPORTED', 'product_import', id(), { created, updated });
    return { created, updated };
  });
}

export function requestProduct(db, actorId, input) {
  const barcode = requireText(input.barcode, '条码', 64);
  const name = requireText(input.name, '商品名称', 120);
  const price = positive(input.priceCents, '建议售价');
  return transaction(db, () => {
    if (row(db, 'SELECT id FROM products WHERE barcode=?', barcode)) throw new AppError('该条码已在商品库中，请重新扫描');
    if (row(db, "SELECT id FROM product_requests WHERE barcode=? AND status='PENDING'", barcode)) throw new AppError('该条码已有待审核建档申请');
    const requestId = id();
    run(db, 'INSERT INTO product_requests(id,barcode,suggested_name,suggested_price_cents,requested_by,status,created_at) VALUES (?,?,?,?,?,?,?)', requestId, barcode, name, price, actorId, 'PENDING', now());
    audit(db, actorId, 'PRODUCT_REQUESTED', 'product_request', requestId, { barcode, name, suggestedPriceCents: price });
    return row(db, 'SELECT * FROM product_requests WHERE id=?', requestId);
  });
}

export function decideProductRequest(db, ownerId, requestId, input) {
  return transaction(db, () => {
    const request = row(db, 'SELECT * FROM product_requests WHERE id=?', requestId);
    if (!request || request.status !== 'PENDING') throw new AppError('建档申请不存在或已处理');
    const approved = input.approve === true;
    const reason = requireText(input.reason || (approved ? '店主审核建档' : ''), '审核说明', 200);
    let productId = null;
    if (approved) {
      const name = requireText(input.name, '商品名称', 120);
      const unit = oneOf(input.unit, ['piece', 'kg'], '单位');
      const price = positive(input.priceCents, '售价');
      const stock = nonnegative(input.stockMilli ?? 0, '初始库存');
      if (unit === 'piece' && stock % 1000 !== 0) throw new AppError('按件商品的库存必须是整数');
      if (row(db, 'SELECT id FROM products WHERE barcode=?', request.barcode)) throw new AppError('该条码已建档，请拒绝重复申请');
      productId = id();
      const time = now();
      run(db, 'INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)', productId, request.barcode, name, unit, price, stock, 1, time, time);
      run(db, 'INSERT INTO price_history VALUES (?,?,?,?,?,?,?)', id(), productId, null, price, ownerId, reason, time);
      if (stock) run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), productId, stock, 'OPENING', null, '建档初始库存', ownerId, time);
    }
    run(db, 'UPDATE product_requests SET status=?,reviewed_by=?,reviewed_at=?,resolution=?,product_id=? WHERE id=?', approved ? 'APPROVED' : 'REJECTED', ownerId, now(), reason, productId, requestId);
    audit(db, ownerId, approved ? 'PRODUCT_REQUEST_APPROVED' : 'PRODUCT_REQUEST_REJECTED', 'product_request', requestId, { productId, reason });
    return row(db, 'SELECT * FROM product_requests WHERE id=?', requestId);
  });
}

export function adjustStock(db, actorId, productId, deltaMilli, reason) {
  if (!Number.isSafeInteger(deltaMilli) || deltaMilli === 0) throw new AppError('库存变动必须是非零整数');
  const note = requireText(reason, '库存调整原因', 200);
  return transaction(db, () => {
    const product = row(db, 'SELECT * FROM products WHERE id=?', productId);
    if (!product) throw new AppError('商品不存在', 404);
    run(db, 'UPDATE products SET stock_milli=stock_milli+?,updated_at=? WHERE id=?', deltaMilli, now(), productId);
    run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), productId, deltaMilli, 'ADJUSTMENT', null, note, actorId, now());
    audit(db, actorId, 'STOCK_ADJUSTED', 'product', productId, { deltaMilli, reason: note });
    return row(db, 'SELECT * FROM products WHERE id=?', productId);
  });
}

export function countStock(db, actorId, productId, countedMilli, reason) {
  const counted = nonnegative(countedMilli, '实盘库存');
  const note = requireText(reason, '抽盘说明', 200);
  return transaction(db, () => {
    const product = row(db, 'SELECT * FROM products WHERE id=?', productId);
    if (!product) throw new AppError('商品不存在', 404);
    const delta = counted - product.stock_milli;
    if (delta) {
      run(db, 'UPDATE products SET stock_milli=?,updated_at=? WHERE id=?', counted, now(), productId);
      run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), productId, delta, 'COUNT', null, note, actorId, now());
      exception(db, 'STOCK_DIFFERENCE', Math.abs(delta) >= 5000 ? 'MEDIUM' : 'LOW', 'product', productId, `${product.name} 抽盘差异 ${delta > 0 ? '+' : ''}${(delta / 1000).toFixed(3)} ${product.unit === 'kg' ? 'kg' : '件'}`);
    }
    audit(db, actorId, 'STOCK_COUNTED', 'product', productId, { expectedMilli: product.stock_milli, countedMilli: counted, differenceMilli: delta, reason: note });
    return { product: row(db, 'SELECT * FROM products WHERE id=?', productId), differenceMilli: delta };
  });
}

export function currentShift(db, userId) {
  return row(db, 'SELECT * FROM shifts WHERE user_id=? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1', userId) || null;
}

export function openShift(db, userId, openingCashCents) {
  const cash = nonnegative(openingCashCents, '备用金');
  return transaction(db, () => {
    if (row(db, 'SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1')) throw new AppError('已有未结束的班次，请先完成交班');
    const shiftId = id();
    run(db, 'INSERT INTO shifts(id,user_id,opening_cash_cents,opened_at) VALUES (?,?,?,?)', shiftId, userId, cash, now());
    audit(db, userId, 'SHIFT_OPENED', 'shift', shiftId, { openingCashCents: cash });
    return row(db, 'SELECT * FROM shifts WHERE id=?', shiftId);
  });
}

export function addCashEvent(db, actorId, shiftId, input) {
  const type = oneOf(input.type, ['ADD', 'PAYOUT', 'DROP'], '现金变动类型');
  const amount = positive(input.amountCents, '金额');
  const reason = requireText(input.reason, '现金变动原因', 200);
  return transaction(db, () => {
    const shift = row(db, 'SELECT * FROM shifts WHERE id=?', shiftId);
    if (!shift || shift.closed_at) throw new AppError('班次不存在或已结束');
    const eventId = id();
    run(db, 'INSERT INTO cash_events VALUES (?,?,?,?,?,?,?)', eventId, shiftId, type, amount, reason, actorId, now());
    audit(db, actorId, 'CASH_EVENT_CREATED', 'cash_event', eventId, { shiftId, type, amountCents: amount, reason });
    return row(db, 'SELECT * FROM cash_events WHERE id=?', eventId);
  });
}

export function recordDrawerOpen(db, actorId, shiftId, reason) {
  const note = requireText(reason, '开钱箱原因', 200);
  return transaction(db, () => {
    const shift = row(db, 'SELECT * FROM shifts WHERE id=?', shiftId);
    if (!shift || shift.user_id !== actorId || shift.closed_at) throw new AppError('只能登记自己当前班次的开钱箱操作');
    audit(db, actorId, 'DRAWER_OPEN_RECORDED', 'shift', shiftId, { reason: note });
    exception(db, 'DRAWER_OPEN', 'LOW', 'shift', shiftId, `非销售开钱箱记录：${note}`);
    return { shiftId, reason: note, recordedAt: now() };
  });
}

export function shiftExpectedCash(db, shiftId) {
  const shift = row(db, 'SELECT * FROM shifts WHERE id=?', shiftId);
  if (!shift) throw new AppError('班次不存在', 404);
  const cashSales = row(db, "SELECT COALESCE(SUM(total_cents),0) AS amount FROM orders WHERE shift_id=? AND method='cash' AND completed_at IS NOT NULL", shiftId).amount;
  const events = rows(db, 'SELECT type,COALESCE(SUM(amount_cents),0) AS amount FROM cash_events WHERE shift_id=? GROUP BY type', shiftId);
  const byType = Object.fromEntries(events.map((event) => [event.type, event.amount]));
  const expected = shift.opening_cash_cents + cashSales + (byType.ADD || 0) - (byType.PAYOUT || 0) - (byType.DROP || 0) - (byType.REFUND || 0);
  return { opening: shift.opening_cash_cents, sales: cashSales, add: byType.ADD || 0, payout: byType.PAYOUT || 0, drop: byType.DROP || 0, refund: byType.REFUND || 0, expected };
}

export function closeShift(db, userId, shiftId, countedCashCents, note = '') {
  const counted = nonnegative(countedCashCents, '实点现金');
  return transaction(db, () => {
    const shift = row(db, 'SELECT * FROM shifts WHERE id=?', shiftId);
    if (!shift || shift.user_id !== userId || shift.closed_at) throw new AppError('只能结束自己的未结班次');
    const breakdown = shiftExpectedCash(db, shiftId);
    const discrepancy = counted - breakdown.expected;
    run(db, 'UPDATE shifts SET closed_at=?,counted_cash_cents=?,expected_cash_cents=?,discrepancy_cents=?,closing_note=? WHERE id=?', now(), counted, breakdown.expected, discrepancy, String(note).trim().slice(0, 500), shiftId);
    if (discrepancy !== 0) exception(db, 'CASH_DIFFERENCE', Math.abs(discrepancy) >= 2000 ? 'HIGH' : 'MEDIUM', 'shift', shiftId, `现金差额 ${discrepancy > 0 ? '+' : ''}${(discrepancy / 100).toFixed(2)} 元`);
    audit(db, userId, 'SHIFT_CLOSED', 'shift', shiftId, { countedCashCents: counted, ...breakdown, discrepancyCents: discrepancy });
    return { ...row(db, 'SELECT * FROM shifts WHERE id=?', shiftId), breakdown };
  });
}

export function createOrder(db, userId, input) {
  const method = oneOf(input.method, ['cash', 'wechat', 'alipay'], '支付方式');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new AppError('订单需要 1–100 种商品');
  const discount = nonnegative(input.discountCents ?? 0, '折扣');
  return transaction(db, () => {
    const shift = currentShift(db, userId);
    if (!shift) throw new AppError('请先开班');
    let approvalNeeded = discount > 0;
    const itemRows = input.items.map((item) => {
      const product = row(db, 'SELECT p.*,c.latest_cost_cents FROM products p LEFT JOIN product_costs c ON c.product_id=p.id WHERE p.id=? AND p.active=1', item.productId);
      if (!product) throw new AppError('订单包含不存在或已停用的商品');
      const quantity = positive(item.quantityMilli, '数量');
      if (product.unit === 'piece' && quantity % 1000 !== 0) throw new AppError(`${product.name} 只能按整件销售`);
      const price = item.unitPriceCents === undefined ? product.price_cents : nonnegative(item.unitPriceCents, '成交单价');
      if (price !== product.price_cents) approvalNeeded = true;
      const line = Math.round(price * quantity / 1000);
      return { product, quantity, price, line };
    });
    const subtotal = itemRows.reduce((sum, item) => sum + item.line, 0);
    if (subtotal <= 0 || discount >= subtotal) throw new AppError('应付金额必须大于零');
    const reason = approvalNeeded ? requireText(input.overrideReason, '改价或折扣原因', 200) : '';
    const orderId = id();
    const status = approvalNeeded ? 'AWAITING_APPROVAL' : 'AWAITING_PAYMENT';
    run(db, 'INSERT INTO orders(id,shift_id,user_id,status,method,subtotal_cents,discount_cents,total_cents,override_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', orderId, shift.id, userId, status, method, subtotal, discount, subtotal - discount, reason, now());
    for (const item of itemRows) {
      const itemId = id();
      run(db, 'INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?,?,?)', itemId, orderId, item.product.id, item.product.barcode, item.product.name, item.product.unit, item.product.price_cents, item.price, item.quantity, item.line);
      if (item.product.latest_cost_cents !== null) run(db, 'INSERT INTO order_item_costs VALUES (?,?)', itemId, item.product.latest_cost_cents);
    }
    audit(db, userId, 'ORDER_CREATED', 'order', orderId, { method, subtotalCents: subtotal, discountCents: discount, status, reason });
    return getOrder(db, orderId);
  });
}

export function getOrder(db, orderId) {
  const order = row(db, 'SELECT o.*,u.display_name AS cashier_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?', orderId);
  if (!order) throw new AppError('订单不存在', 404);
  return { ...order, items: rows(db, 'SELECT * FROM order_items WHERE order_id=?', orderId), payment: row(db, 'SELECT * FROM payments WHERE order_id=?', orderId) || null, refund: row(db, 'SELECT * FROM refund_requests WHERE order_id=? ORDER BY created_at DESC LIMIT 1', orderId) || null };
}

export function listOrders(db, limit = 100) {
  return rows(db, 'SELECT o.*,u.display_name AS cashier_name FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT ?', Math.min(200, Math.max(1, Number(limit) || 100)));
}

export function decideOrder(db, ownerId, orderId, approve, note = '') {
  return transaction(db, () => {
    const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.status !== 'AWAITING_APPROVAL') throw new AppError('订单不在待审批状态');
    run(db, 'UPDATE orders SET status=?,voided_at=? WHERE id=?', approve ? 'AWAITING_PAYMENT' : 'VOIDED', approve ? null : now(), orderId);
    audit(db, ownerId, approve ? 'PRICE_APPROVED' : 'PRICE_REJECTED', 'order', orderId, { reason: String(note).slice(0, 200) });
    return getOrder(db, orderId);
  });
}

function postInventory(db, orderId, actorId, multiplier, type) {
  const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
  if (multiplier === -1 && order.inventory_posted) return;
  if (multiplier === 1 && !order.inventory_posted) return;
  const items = rows(db, 'SELECT * FROM order_items WHERE order_id=?', orderId);
  for (const item of items) {
    const delta = multiplier * item.quantity_milli;
    run(db, 'UPDATE products SET stock_milli=stock_milli+?,updated_at=? WHERE id=?', delta, now(), item.product_id);
    run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), item.product_id, delta, type, orderId, `订单 ${orderId.slice(0, 8)}`, actorId, now());
    const stock = row(db, 'SELECT stock_milli,name FROM products WHERE id=?', item.product_id);
    if (stock.stock_milli < 0) exception(db, 'NEGATIVE_STOCK', 'LOW', 'product', item.product_id, `${stock.name} 库存为负，请抽盘`);
  }
  run(db, 'UPDATE orders SET inventory_posted=? WHERE id=?', multiplier === -1 ? 1 : 0, orderId);
}

export function payOrder(db, actorId, orderId, receivedCashCents = null) {
  return transaction(db, () => {
    const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.status !== 'AWAITING_PAYMENT') throw new AppError('订单不能收款');
    const shift = row(db, 'SELECT * FROM shifts WHERE id=?', order.shift_id);
    if (shift.closed_at) throw new AppError('班次已结束');
    if (actorId !== order.user_id) throw new AppError('只能收取自己班次的订单', 403);
    if (order.method === 'cash') {
      const received = nonnegative(receivedCashCents, '实收现金');
      if (received < order.total_cents) throw new AppError('实收现金不足');
      run(db, "UPDATE orders SET status='COMPLETED',received_cash_cents=?,change_cents=?,completed_at=? WHERE id=?", received, received - order.total_cents, now(), orderId);
      postInventory(db, orderId, actorId, -1, 'SALE');
    } else {
      run(db, "UPDATE orders SET status='PAYMENT_PENDING' WHERE id=?", orderId);
      run(db, 'INSERT INTO payments(id,order_id,channel,status,transaction_id,claimed_transaction_id,amount_cents,source,verified_at,verifier_id) VALUES (?,?,?,?,?,?,?,?,?,?)', id(), orderId, order.method, 'PENDING', null, null, order.total_cents, null, null, null);
      postInventory(db, orderId, actorId, -1, 'PENDING_SALE');
    }
    audit(db, actorId, order.method === 'cash' ? 'CASH_PAID' : 'DIGITAL_PAYMENT_PENDING', 'order', orderId, { receivedCashCents });
    return getOrder(db, orderId);
  });
}

export function claimPaymentReference(db, actorId, orderId, transactionId) {
  const claimed = requireText(transactionId, '顾客出示的交易号', 120);
  return transaction(db, () => {
    const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.user_id !== actorId || order.status !== 'PAYMENT_PENDING') throw new AppError('只能填写自己待核实订单的交易号');
    const payment = row(db, 'SELECT * FROM payments WHERE order_id=?', orderId);
    if (!payment || payment.status !== 'PENDING') throw new AppError('此订单已核实付款');
    const existing = row(db, 'SELECT order_id FROM payments WHERE channel=? AND claimed_transaction_id=?', order.method, claimed);
    if (existing && existing.order_id !== orderId) throw new AppError('该交易号已用于另一张订单');
    run(db, 'UPDATE payments SET claimed_transaction_id=? WHERE order_id=?', claimed, orderId);
    audit(db, actorId, 'PAYMENT_REFERENCE_CLAIMED', 'order', orderId, { claimedTransactionId: claimed });
    return getOrder(db, orderId);
  });
}

export function voidOrder(db, ownerId, orderId, reason) {
  const note = requireText(reason, '取消原因', 200);
  return transaction(db, () => {
    const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order || !['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(order.status)) throw new AppError('此订单不能取消');
    if (order.status === 'PAYMENT_PENDING') {
      const statement = row(db, 'SELECT id FROM payment_statements WHERE merchant_order_id=? OR matched_order_id=?', orderId, orderId);
      if (statement) throw new AppError('已有渠道流水，需先核对付款，不能取消');
    }
    if (order.inventory_posted) postInventory(db, orderId, ownerId, 1, 'VOID_RESTORE');
    run(db, "UPDATE orders SET status='VOIDED',voided_at=? WHERE id=?", now(), orderId);
    if (order.status === 'PAYMENT_PENDING') exception(db, 'VOIDED_PENDING_PAYMENT', 'HIGH', 'order', orderId, '待核实扫码订单被取消，请核对渠道是否实际收款');
    audit(db, ownerId, 'ORDER_VOIDED', 'order', orderId, { reason: note });
    return getOrder(db, orderId);
  });
}

function matchStatement(db, statement, orderId, actorId) {
  const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
  if (!order || order.status !== 'PAYMENT_PENDING' || order.method !== statement.channel || order.total_cents !== statement.amount_cents) return false;
  const payment = row(db, 'SELECT * FROM payments WHERE order_id=?', orderId);
  if (!payment || payment.status !== 'PENDING') return false;
  if (payment.claimed_transaction_id && payment.claimed_transaction_id !== statement.transaction_id) {
    exception(db, 'CLAIM_MISMATCH', 'MEDIUM', 'order', orderId, '收银员记录的交易号与渠道流水交易号不同，请复核');
  }
  run(db, 'UPDATE payment_statements SET matched_order_id=? WHERE id=?', orderId, statement.id);
  run(db, "UPDATE payments SET status='SUCCEEDED',transaction_id=?,source='CHANNEL_STATEMENT',verified_at=?,verifier_id=? WHERE order_id=?", statement.transaction_id, now(), actorId, orderId);
  run(db, "UPDATE orders SET status='COMPLETED',completed_at=? WHERE id=?", statement.paid_at, orderId);
  run(db, "UPDATE exceptions SET status='RESOLVED',resolved_at=?,resolved_by=?,resolution='已匹配渠道流水' WHERE entity_type='statement' AND entity_id=? AND status='OPEN'", now(), actorId, statement.id);
  audit(db, actorId, 'PAYMENT_VERIFIED', 'order', orderId, { statementId: statement.id, transactionId: statement.transaction_id });
  return true;
}

export function importStatements(db, ownerId, inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 5000) throw new AppError('一次导入 1–5000 条流水');
  const parsed = inputs.map((input, index) => {
    try {
      const paidAt = requireText(input.paidAt, '付款时间', 40);
      if (!Number.isFinite(Date.parse(paidAt))) throw new AppError('付款时间无效');
      return { channel: oneOf(input.channel, ['wechat', 'alipay'], '渠道'), transactionId: requireText(input.transactionId, '交易号', 120), merchantOrderId: String(input.orderId || '').trim() || null, amountCents: positive(input.amountCents, '金额'), status: oneOf(input.status, ['SUCCESS'], '交易状态'), paidAt: new Date(paidAt).toISOString() };
    } catch (error) { throw new AppError(`第 ${index + 1} 行：${error.message}`); }
  });
  return transaction(db, () => {
    let matched = 0;
    let unmatched = 0;
    let duplicate = 0;
    for (const input of parsed) {
      const previous = row(db, 'SELECT * FROM payment_statements WHERE channel=? AND transaction_id=?', input.channel, input.transactionId);
      if (previous) {
        if (previous.amount_cents !== input.amountCents || previous.merchant_order_id !== input.merchantOrderId) exception(db, 'CONFLICTING_STATEMENT', 'HIGH', 'statement', previous.id, `交易号 ${input.transactionId} 的重复流水金额或订单号不一致`);
        duplicate++; continue;
      }
      const statementId = id();
      run(db, 'INSERT INTO payment_statements(id,channel,transaction_id,merchant_order_id,amount_cents,paid_at,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?)', statementId, input.channel, input.transactionId, input.merchantOrderId, input.amountCents, input.paidAt, ownerId, now());
      const statement = row(db, 'SELECT * FROM payment_statements WHERE id=?', statementId);
      const hintedOrder = !input.merchantOrderId ? row(db, "SELECT order_id FROM payments WHERE channel=? AND claimed_transaction_id=? AND status='PENDING'", input.channel, input.transactionId)?.order_id : null;
      const candidateOrder = input.merchantOrderId || hintedOrder;
      if (candidateOrder && matchStatement(db, statement, candidateOrder, ownerId)) matched++;
      else {
        unmatched++;
        exception(db, 'UNMATCHED_PAYMENT', 'HIGH', 'statement', statementId, `${input.channel} 渠道流水 ${input.transactionId} 暂未匹配订单`);
      }
    }
    audit(db, ownerId, 'STATEMENTS_IMPORTED', 'payment_statement_import', id(), { matched, unmatched, duplicate });
    return { matched, unmatched, duplicate };
  });
}

export function linkStatement(db, ownerId, statementId, orderId) {
  return transaction(db, () => {
    const statement = row(db, 'SELECT * FROM payment_statements WHERE id=?', statementId);
    if (!statement || statement.matched_order_id) throw new AppError('流水不存在或已匹配');
    if (statement.merchant_order_id && statement.merchant_order_id !== orderId) throw new AppError('该渠道流水已有不同商户订单号，不能改绑');
    if (!matchStatement(db, statement, orderId, ownerId)) throw new AppError('订单状态、渠道或金额不匹配');
    return getOrder(db, orderId);
  });
}

export function requestRefund(db, actorId, orderId, reason) {
  const note = requireText(reason, '退款原因', 200);
  return transaction(db, () => {
    const order = row(db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.status !== 'COMPLETED') throw new AppError('只能申请已完成订单的全额退款');
    if (row(db, "SELECT id FROM refund_requests WHERE order_id=? AND status IN ('PENDING','APPROVED','COMPLETED')", orderId)) throw new AppError('已有退款申请');
    const refundId = id();
    run(db, "INSERT INTO refund_requests(id,order_id,requested_by,reason,status,created_at) VALUES (?,?,?,?,?,?)", refundId, orderId, actorId, note, 'PENDING', now());
    audit(db, actorId, 'REFUND_REQUESTED', 'refund', refundId, { orderId, reason: note });
    return row(db, 'SELECT * FROM refund_requests WHERE id=?', refundId);
  });
}

export function decideRefund(db, ownerId, refundId, approve) {
  return transaction(db, () => {
    const refund = row(db, 'SELECT * FROM refund_requests WHERE id=?', refundId);
    if (!refund || refund.status !== 'PENDING') throw new AppError('退款申请不在待审批状态');
    run(db, 'UPDATE refund_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?', approve ? 'APPROVED' : 'REJECTED', ownerId, now(), refundId);
    audit(db, ownerId, approve ? 'REFUND_APPROVED' : 'REFUND_REJECTED', 'refund', refundId, { orderId: refund.order_id });
    return row(db, 'SELECT * FROM refund_requests WHERE id=?', refundId);
  });
}

export function completeRefund(db, actorId, refundId, reference, restock) {
  return transaction(db, () => {
    const refund = row(db, 'SELECT * FROM refund_requests WHERE id=?', refundId);
    if (!refund || refund.status !== 'APPROVED') throw new AppError('退款尚未获批或已处理');
    const order = row(db, 'SELECT * FROM orders WHERE id=?', refund.order_id);
    if (order.status !== 'COMPLETED') throw new AppError('订单状态已变化');
    const cashShift = order.method === 'cash' ? currentShift(db, actorId) : null;
    if (order.method === 'cash' && !cashShift) throw new AppError('现金退款前，操作人须先开班并从当前抽屉支付');
    const ref = order.method === 'cash' ? String(reference || '现金已退').trim() : requireText(reference, '渠道退款流水号', 120);
    if (order.method === 'cash') run(db, 'INSERT INTO cash_events VALUES (?,?,?,?,?,?,?)', id(), cashShift.id, 'REFUND', order.total_cents, `订单 ${order.id.slice(0, 8)} 全额退款`, actorId, now());
    if (restock) postInventory(db, order.id, actorId, 1, 'REFUND_RESTOCK');
    run(db, "UPDATE refund_requests SET status='COMPLETED',completed_by=?,completed_at=?,refund_reference=?,restocked=? WHERE id=?", actorId, now(), ref, restock ? 1 : 0, refundId);
    run(db, "UPDATE orders SET status='REFUNDED' WHERE id=?", order.id);
    audit(db, actorId, 'REFUND_COMPLETED', 'refund', refundId, { orderId: order.id, reference: ref, restock: !!restock });
    return getOrder(db, order.id);
  });
}

function monthlyOverview(db, today) {
  const [year, month] = today.slice(0, 7).split('-').map(Number);
  const monthKeys = Array.from({ length: 13 }, (_, index) => new Date(Date.UTC(year, month - 13 + index, 1)).toISOString().slice(0, 7));
  const [firstYear, firstMonth] = monthKeys[0].split('-').map(Number);
  const from = new Date(Date.UTC(firstYear, firstMonth - 1, 1, -8)).toISOString();
  const until = new Date(Date.UTC(year, month, 1, -8)).toISOString();
  const summary = new Map(monthKeys.map((key) => [key, {
    month: key, orderCount: 0, grossCents: 0, refundCount: 0, refundCents: 0,
    netCents: 0, cashCents: 0, wechatCents: 0, alipayCents: 0, pendingCount: 0,
  }]));
  const sales = rows(db, `SELECT strftime('%Y-%m',completed_at,'+8 hours') AS month,method,COUNT(*) AS count,COALESCE(SUM(total_cents),0) AS amount
    FROM orders WHERE completed_at>=? AND completed_at<? AND status IN ('COMPLETED','REFUNDED') GROUP BY month,method`, from, until);
  for (const sale of sales) {
    const item = summary.get(sale.month);
    if (!item) continue;
    item.orderCount += sale.count;
    item.grossCents += sale.amount;
    if (sale.method === 'cash') item.cashCents = sale.amount;
    if (sale.method === 'wechat') item.wechatCents = sale.amount;
    if (sale.method === 'alipay') item.alipayCents = sale.amount;
  }
  const refunds = rows(db, `SELECT strftime('%Y-%m',r.completed_at,'+8 hours') AS month,COUNT(*) AS count,COALESCE(SUM(o.total_cents),0) AS amount
    FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE r.status='COMPLETED' AND r.completed_at>=? AND r.completed_at<? GROUP BY month`, from, until);
  for (const refund of refunds) {
    const item = summary.get(refund.month);
    if (!item) continue;
    item.refundCount = refund.count;
    item.refundCents = refund.amount;
  }
  const pending = rows(db, `SELECT strftime('%Y-%m',created_at,'+8 hours') AS month,COUNT(*) AS count
    FROM orders WHERE status='PAYMENT_PENDING' AND created_at>=? AND created_at<? GROUP BY month`, from, until);
  for (const entry of pending) {
    const item = summary.get(entry.month);
    if (item) item.pendingCount = entry.count;
  }
  return [...summary.values()].map((item) => ({ ...item, netCents: item.grossCents - item.refundCents }));
}

export function dashboard(db) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sales = rows(db, "SELECT method,COUNT(*) AS count,COALESCE(SUM(total_cents),0) AS amount FROM orders WHERE date(completed_at,'+8 hours')=? AND status IN ('COMPLETED','REFUNDED') GROUP BY method", today);
  const refundsToday = row(db, "SELECT COALESCE(SUM(o.total_cents),0) AS amount FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE r.status='COMPLETED' AND date(r.completed_at,'+8 hours')=?", today).amount;
  const pending = row(db, "SELECT COUNT(*) AS count,COALESCE(SUM(total_cents),0) AS amount FROM orders WHERE status='PAYMENT_PENDING'");
  const pendingOrders = rows(db, "SELECT o.id,o.created_at,o.method,o.total_cents,u.display_name AS cashier_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='PAYMENT_PENDING' ORDER BY o.created_at ASC LIMIT 50");
  const approvals = rows(db, "SELECT id AS entity_id,id AS order_id,'PRICE' AS kind,created_at AS time,total_cents AS amount FROM orders WHERE status='AWAITING_APPROVAL' UNION ALL SELECT r.id AS entity_id,r.order_id AS order_id,'REFUND' AS kind,r.created_at AS time,o.total_cents AS amount FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE r.status='PENDING' ORDER BY time DESC");
  const exceptions = rows(db, "SELECT * FROM exceptions WHERE status='OPEN' ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,created_at DESC LIMIT 100");
  const recentShifts = rows(db, 'SELECT s.*,u.display_name AS cashier_name FROM shifts s JOIN users u ON u.id=s.user_id ORDER BY s.opened_at DESC LIMIT 20');
  const statements = rows(db, 'SELECT * FROM payment_statements WHERE matched_order_id IS NULL ORDER BY paid_at DESC LIMIT 100');
  const statementSummary = row(db, 'SELECT COUNT(*) AS count,COALESCE(SUM(amount_cents),0) AS amount FROM payment_statements WHERE matched_order_id IS NULL');
  const cashIssues = rows(db, "SELECT e.*,s.discrepancy_cents,s.closed_at,s.opened_at,u.display_name AS cashier_name FROM exceptions e LEFT JOIN shifts s ON e.entity_type='shift' AND e.entity_id=s.id LEFT JOIN users u ON u.id=s.user_id WHERE e.status='OPEN' AND e.kind='CASH_DIFFERENCE' ORDER BY e.created_at DESC LIMIT 100");
  const cashIssueSummary = row(db, "SELECT COUNT(*) AS count,COALESCE(SUM(ABS(COALESCE(s.discrepancy_cents,0))),0) AS absolute_amount FROM exceptions e LEFT JOIN shifts s ON e.entity_type='shift' AND e.entity_id=s.id WHERE e.status='OPEN' AND e.kind='CASH_DIFFERENCE'");
  const stockIssues = rows(db, "SELECT * FROM exceptions WHERE status='OPEN' AND kind IN ('STOCK_DIFFERENCE','NEGATIVE_STOCK') ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,created_at DESC LIMIT 100");
  const otherIssues = rows(db, "SELECT * FROM exceptions WHERE status='OPEN' AND kind NOT IN ('CASH_DIFFERENCE','STOCK_DIFFERENCE','NEGATIVE_STOCK') ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,created_at DESC LIMIT 100");
  const exceptionCounts = Object.fromEntries(rows(db, "SELECT kind,COUNT(*) AS count FROM exceptions WHERE status='OPEN' GROUP BY kind").map((item) => [item.kind, item.count]));
  const productRequests = rows(db, "SELECT p.*,u.display_name AS requester_name FROM product_requests p JOIN users u ON u.id=p.requested_by WHERE p.status='PENDING' ORDER BY p.created_at ASC LIMIT 100");
  const productRequestCount = row(db, "SELECT COUNT(*) AS count FROM product_requests WHERE status='PENDING'").count;
  return { today, sales, refundsToday, pending, pendingOrders, approvals, exceptions, recentShifts, statements, statementSummary, cashIssues, cashIssueSummary, stockIssues, otherIssues, exceptionCounts, productRequests, productRequestCount, monthly: monthlyOverview(db, today) };
}

export function resolveException(db, actorId, exceptionId, resolution) {
  const note = requireText(resolution, '处理说明', 500);
  return transaction(db, () => {
    const issue = row(db, 'SELECT * FROM exceptions WHERE id=?', exceptionId);
    if (!issue || issue.status !== 'OPEN') throw new AppError('异常不存在或已处理');
    run(db, "UPDATE exceptions SET status='RESOLVED',resolved_at=?,resolved_by=?,resolution=? WHERE id=?", now(), actorId, note, exceptionId);
    audit(db, actorId, 'EXCEPTION_RESOLVED', 'exception', exceptionId, { resolution: note });
    return row(db, 'SELECT * FROM exceptions WHERE id=?', exceptionId);
  });
}

export function listAudit(db, limit = 100, actorId = null) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return actorId
    ? rows(db, 'SELECT a.*,u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.actor_id=? ORDER BY a.created_at DESC LIMIT ?', actorId, safeLimit)
    : rows(db, 'SELECT a.*,u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT ?', safeLimit);
}

export function listShifts(db, userId = null) {
  return userId ? rows(db, 'SELECT * FROM shifts WHERE user_id=? ORDER BY opened_at DESC LIMIT 100', userId) : rows(db, 'SELECT s.*,u.display_name AS cashier_name FROM shifts s JOIN users u ON u.id=s.user_id ORDER BY s.opened_at DESC LIMIT 100');
}

export function listCashEvents(db, shiftId) {
  return rows(db, 'SELECT * FROM cash_events WHERE shift_id=? ORDER BY created_at DESC', shiftId);
}

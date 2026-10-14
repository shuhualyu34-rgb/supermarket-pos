import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { AppError, audit, now, updateProductCost } from './domain.js';

const id = () => randomUUID();
const row = (db, sql, ...params) => db.prepare(sql).get(...params);
const rows = (db, sql, ...params) => db.prepare(sql).all(...params);
const run = (db, sql, ...params) => db.prepare(sql).run(...params);

function textField(value, label, max, required = false) {
  const valueText = String(value ?? '').trim();
  if ((required && !valueText) || valueText.length > max) throw new AppError(`${label}${required ? '不能为空，且' : ''}不能超过 ${max} 字`);
  return valueText;
}

function amount(value, label, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) throw new AppError(`${label}无效`);
  return value;
}

export function saveSupplier(db, actorId, input, supplierId = null) {
  const name = textField(input.name, '供应商名称', 100, true);
  const contactName = textField(input.contactName, '联系人', 60);
  const phone = textField(input.phone, '联系电话', 40);
  const notes = textField(input.notes, '备注', 300);
  return transaction(db, () => {
    const existing = supplierId ? row(db, 'SELECT * FROM suppliers WHERE id=?', supplierId) : null;
    if (supplierId && !existing) throw new AppError('供应商不存在', 404);
    const active = input.active === undefined ? (existing?.active ?? 1) : (input.active === false ? 0 : 1);
    const supplier = supplierId || id();
    const timestamp = now();
    if (existing) run(db, 'UPDATE suppliers SET name=?,contact_name=?,phone=?,notes=?,active=?,updated_at=? WHERE id=?', name, contactName, phone, notes, active, timestamp, supplier);
    else run(db, 'INSERT INTO suppliers VALUES (?,?,?,?,?,?,?,?)', supplier, name, contactName, phone, notes, active, timestamp, timestamp);
    audit(db, actorId, existing ? 'SUPPLIER_UPDATED' : 'SUPPLIER_CREATED', 'supplier', supplier, { name, active: !!active });
    return row(db, 'SELECT * FROM suppliers WHERE id=?', supplier);
  });
}

export function recordReceipt(db, actorId, input) {
  const supplierId = textField(input.supplierId, '供应商', 100, true);
  const referenceNo = textField(input.referenceNo, '供货单号', 80) || null;
  const note = textField(input.note, '到货备注', 300);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new AppError('每次到货需登记 1–100 种商品');
  const items = input.items.map((item, index) => {
    try {
      if (!item || typeof item !== 'object') throw new AppError('商品资料无效');
      return {
        barcode: textField(item.barcode, '商品条码', 64, true),
        quantityMilli: amount(item.quantityMilli, '到货数量', false),
        unitCostCents: amount(item.unitCostCents, '进货单价'),
      };
    } catch (error) { throw new AppError(`第 ${index + 1} 行：${error.message}`); }
  });
  if (new Set(items.map((item) => item.barcode)).size !== items.length) throw new AppError('同一张到货单不能重复填写同一个条码');
  return transaction(db, () => {
    const supplier = row(db, 'SELECT * FROM suppliers WHERE id=?', supplierId);
    if (!supplier || !supplier.active) throw new AppError('请选择已启用的供应商');
    if (referenceNo && row(db, 'SELECT id FROM purchase_receipts WHERE supplier_id=? AND reference_no=?', supplierId, referenceNo)) throw new AppError('该供应商的供货单号已登记，请勿重复入库', 409);
    let totalCostCents = 0;
    const lines = items.map((item) => {
      const product = row(db, 'SELECT * FROM products WHERE barcode=? AND active=1', item.barcode);
      if (!product) throw new AppError(`条码 ${item.barcode} 未建档或已停用，请先到“商品与库存”录入`);
      if (product.unit === 'piece' && item.quantityMilli % 1000 !== 0) throw new AppError(`${product.name} 按件计量，数量必须是整数`);
      if (!Number.isSafeInteger(product.stock_milli + item.quantityMilli)) throw new AppError(`${product.name} 入库后库存超出支持范围`);
      const lineCostBig = (BigInt(item.unitCostCents) * BigInt(item.quantityMilli) + 500n) / 1000n;
      if (lineCostBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('到货金额超出支持范围');
      const lineCostCents = Number(lineCostBig);
      if (!Number.isSafeInteger(totalCostCents + lineCostCents)) throw new AppError('到货金额超出支持范围');
      totalCostCents += lineCostCents;
      return { ...item, product, lineCostCents };
    });
    const receiptId = id();
    const timestamp = now();
    run(db, 'INSERT INTO purchase_receipts VALUES (?,?,?,?,?,?,?)', receiptId, supplierId, referenceNo, note, totalCostCents, actorId, timestamp);
    for (const line of lines) {
      run(db, 'INSERT INTO purchase_receipt_items VALUES (?,?,?,?,?,?,?,?,?)', id(), receiptId, line.product.id, line.product.barcode, line.product.name, line.product.unit, line.quantityMilli, line.unitCostCents, line.lineCostCents);
      run(db, 'UPDATE products SET stock_milli=stock_milli+?,updated_at=? WHERE id=?', line.quantityMilli, timestamp, line.product.id);
      run(db, 'INSERT INTO inventory_events VALUES (?,?,?,?,?,?,?,?)', id(), line.product.id, line.quantityMilli, 'PURCHASE_RECEIPT', receiptId, `供应商到货：${supplier.name}`, actorId, timestamp);
      updateProductCost(db, actorId, line.product.id, line.unitCostCents, 'RECEIPT', receiptId);
    }
    audit(db, actorId, 'PURCHASE_RECEIVED', 'purchase_receipt', receiptId, { supplierId, referenceNo, totalCostCents, itemCount: lines.length });
    return { id: receiptId, supplierId, referenceNo, totalCostCents, receivedAt: timestamp, itemCount: lines.length };
  });
}

export function procurementOverview(db) {
  const suppliers = rows(db, 'SELECT * FROM suppliers ORDER BY active DESC,name');
  const receipts = rows(db, `SELECT r.*,s.name AS supplier_name,u.display_name AS receiver_name
    FROM purchase_receipts r JOIN suppliers s ON s.id=r.supplier_id JOIN users u ON u.id=r.received_by
    ORDER BY r.received_at DESC LIMIT 50`).map((receipt) => ({
    ...receipt,
    items: rows(db, 'SELECT * FROM purchase_receipt_items WHERE receipt_id=? ORDER BY rowid', receipt.id),
  }));
  const products = rows(db, `SELECT p.stock_milli,c.latest_cost_cents FROM products p
    LEFT JOIN product_costs c ON c.product_id=p.id WHERE p.active=1`);
  const summary = { productCount: products.length, costKnownCount: 0, costUnknownCount: 0, negativeStockCount: 0, inventoryValueCents: 0 };
  let inventoryValue = 0n;
  for (const product of products) {
    if (product.stock_milli < 0) summary.negativeStockCount++;
    if (product.latest_cost_cents === null) summary.costUnknownCount++;
    else {
      summary.costKnownCount++;
      inventoryValue += (BigInt(Math.max(0, product.stock_milli)) * BigInt(product.latest_cost_cents) + 500n) / 1000n;
    }
  }
  if (inventoryValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('库存估值超出支持范围');
  summary.inventoryValueCents = Number(inventoryValue);
  return { suppliers, receipts, summary };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import {
  claimPaymentReference, closeShift, completeRefund, createOrder, dashboard, decideOrder, decideRefund,
  getOrder, importProducts, importStatements, openShift, payOrder, requestRefund, saveProduct,
  shiftExpectedCash,
} from '../domain.js';

function fixture() {
  const db = openDatabase(':memory:');
  const owner = 'owner-id';
  const cashier = 'cashier-id';
  const time = new Date().toISOString();
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(owner, 'owner', '店主', 'owner', 'hash', 'salt', 1, time);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(cashier, 'cashier', '收银员', 'cashier', 'hash', 'salt', 1, time);
  importProducts(db, owner, [{ barcode: '10001', name: '牛奶', unit: 'piece', priceCents: 650, stockMilli: 10000 }]);
  const product = db.prepare('SELECT * FROM products WHERE barcode=?').get('10001');
  return { db, owner, cashier, product };
}

test('cash sale and shift close preserve the cash equation', () => {
  const { db, cashier, product } = fixture();
  const shift = openShift(db, cashier, 30000);
  const order = createOrder(db, cashier, { method: 'cash', items: [{ productId: product.id, quantityMilli: 2000 }] });
  const paid = payOrder(db, cashier, order.id, 2000);
  assert.equal(paid.status, 'COMPLETED');
  assert.equal(paid.total_cents, 1300);
  assert.equal(paid.change_cents, 700);
  assert.equal(db.prepare('SELECT stock_milli FROM products WHERE id=?').get(product.id).stock_milli, 8000);
  assert.equal(shiftExpectedCash(db, shift.id).expected, 31300);
  const closed = closeShift(db, cashier, shift.id, 31200, '少 1 元');
  assert.equal(closed.discrepancy_cents, -100);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM exceptions WHERE kind='CASH_DIFFERENCE'").get().count, 1);
  db.close();
});

test('discount requires owner approval before payment', () => {
  const { db, owner, cashier, product } = fixture();
  openShift(db, cashier, 0);
  const order = createOrder(db, cashier, { method: 'cash', items: [{ productId: product.id, quantityMilli: 1000 }], discountCents: 100, overrideReason: '临期优惠' });
  assert.equal(order.status, 'AWAITING_APPROVAL');
  assert.throws(() => payOrder(db, cashier, order.id, 650), /不能收款/);
  decideOrder(db, owner, order.id, true);
  assert.equal(payOrder(db, cashier, order.id, 550).total_cents, 550);
  db.close();
});

test('digital payment remains pending until a matching channel statement arrives', () => {
  const { db, owner, cashier, product } = fixture();
  openShift(db, cashier, 0);
  const order = createOrder(db, cashier, { method: 'wechat', items: [{ productId: product.id, quantityMilli: 1000 }] });
  payOrder(db, cashier, order.id);
  assert.equal(getOrder(db, order.id).status, 'PAYMENT_PENDING');
  const mismatch = importStatements(db, owner, [{ channel: 'wechat', transactionId: 'WX-1', orderId: order.id, amountCents: 500, status: 'SUCCESS', paidAt: new Date().toISOString() }]);
  assert.equal(mismatch.unmatched, 1);
  assert.equal(getOrder(db, order.id).status, 'PAYMENT_PENDING');
  const matching = importStatements(db, owner, [{ channel: 'wechat', transactionId: 'WX-2', orderId: order.id, amountCents: 650, status: 'SUCCESS', paidAt: new Date().toISOString() }]);
  assert.equal(matching.matched, 1);
  assert.equal(getOrder(db, order.id).status, 'COMPLETED');
  assert.equal(dashboard(db).pending.count, 0);
  db.close();
});

test('fixed QR payment reference is only a clue until a real channel statement matches', () => {
  const { db, owner, cashier, product } = fixture();
  openShift(db, cashier, 0);
  const order = createOrder(db, cashier, { method: 'wechat', items: [{ productId: product.id, quantityMilli: 1000 }] });
  payOrder(db, cashier, order.id);
  const claimed = claimPaymentReference(db, cashier, order.id, 'WX-FIXED-123');
  assert.equal(claimed.status, 'PAYMENT_PENDING');
  assert.equal(claimed.payment.claimed_transaction_id, 'WX-FIXED-123');
  const matching = importStatements(db, owner, [{ channel: 'wechat', transactionId: 'WX-FIXED-123', orderId: '', amountCents: 650, status: 'SUCCESS', paidAt: new Date().toISOString() }]);
  assert.equal(matching.matched, 1);
  assert.equal(getOrder(db, order.id).status, 'COMPLETED');
  db.close();
});

test('only one shift can use the drawer and existing product units cannot change', () => {
  const { db, owner, cashier, product } = fixture();
  openShift(db, cashier, 0);
  assert.throws(() => openShift(db, owner, 0), /已有未结束的班次/);
  assert.throws(() => saveProduct(db, owner, { barcode: product.barcode, name: product.name, unit: 'kg', priceCents: 650 }, product.id), /不能直接更改计量单位/);
  assert.throws(() => importProducts(db, owner, [{ barcode: product.barcode, name: product.name, unit: 'kg', priceCents: 650, stockMilli: 0 }]), /计量单位/);
  db.close();
});

test('cash refund uses the current drawer even when the original shift is closed', () => {
  const { db, owner, cashier, product } = fixture();
  const firstShift = openShift(db, cashier, 10000);
  const order = createOrder(db, cashier, { method: 'cash', items: [{ productId: product.id, quantityMilli: 1000 }] });
  payOrder(db, cashier, order.id, 650);
  closeShift(db, cashier, firstShift.id, 10650);
  const secondShift = openShift(db, cashier, 10000);
  const refund = requestRefund(db, cashier, order.id, '退货');
  decideRefund(db, owner, refund.id, true);
  completeRefund(db, cashier, refund.id, '现金已退', true);
  assert.equal(getOrder(db, order.id).status, 'REFUNDED');
  assert.equal(shiftExpectedCash(db, secondShift.id).expected, 9350);
  assert.equal(db.prepare('SELECT stock_milli FROM products WHERE id=?').get(product.id).stock_milli, 10000);
  db.close();
});

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(path = process.env.POS_DB_PATH || resolve('data/pos.sqlite')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','cashier')),
      password_hash TEXT NOT NULL, salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, barcode TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      unit TEXT NOT NULL CHECK(unit IN ('piece','kg')),
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      stock_milli INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE TABLE IF NOT EXISTS product_costs (
      product_id TEXT PRIMARY KEY REFERENCES products(id),
      latest_cost_cents INTEGER NOT NULL CHECK(latest_cost_cents >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_cost_history (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      old_cost_cents INTEGER, new_cost_cents INTEGER NOT NULL CHECK(new_cost_cents >= 0),
      source_type TEXT NOT NULL, source_id TEXT,
      actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_history_product ON product_cost_history(product_id,created_at);
    CREATE TABLE IF NOT EXISTS price_history (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      old_price_cents INTEGER, new_price_cents INTEGER NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_requests (
      id TEXT PRIMARY KEY, barcode TEXT NOT NULL,
      suggested_name TEXT NOT NULL, suggested_price_cents INTEGER NOT NULL,
      requested_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
      reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
      resolution TEXT, product_id TEXT REFERENCES products(id), created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_request_pending ON product_requests(barcode) WHERE status='PENDING';
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      opening_cash_cents INTEGER NOT NULL CHECK(opening_cash_cents >= 0),
      opened_at TEXT NOT NULL, closed_at TEXT,
      counted_cash_cents INTEGER, expected_cash_cents INTEGER,
      discrepancy_cents INTEGER, closing_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_user_open ON shifts(user_id, closed_at);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING','COMPLETED','VOIDED','REFUNDED')),
      method TEXT NOT NULL CHECK(method IN ('cash','wechat','alipay')),
      subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL, received_cash_cents INTEGER,
      change_cents INTEGER, override_reason TEXT,
      inventory_posted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, completed_at TEXT, voided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completed_at);
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      barcode TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      catalog_price_cents INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
      line_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_item_costs (
      order_item_id TEXT PRIMARY KEY REFERENCES order_items(id),
      unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0)
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      reference_no TEXT, note TEXT NOT NULL DEFAULT '', total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents >= 0),
      received_by TEXT NOT NULL REFERENCES users(id), received_at TEXT NOT NULL,
      UNIQUE(supplier_id,reference_no)
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_received ON purchase_receipts(received_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_supplier ON purchase_receipts(supplier_id,received_at);
    CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES purchase_receipts(id),
      product_id TEXT NOT NULL REFERENCES products(id), barcode TEXT NOT NULL, name TEXT NOT NULL,
      unit TEXT NOT NULL, quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
      unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
      line_cost_cents INTEGER NOT NULL CHECK(line_cost_cents >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON purchase_receipt_items(receipt_id);
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
      status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCEEDED')),
      transaction_id TEXT UNIQUE, claimed_transaction_id TEXT,
      amount_cents INTEGER NOT NULL,
      source TEXT, verified_at TEXT, verifier_id TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS payment_statements (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
      transaction_id TEXT NOT NULL, merchant_order_id TEXT,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      paid_at TEXT NOT NULL, matched_order_id TEXT REFERENCES orders(id),
      imported_by TEXT NOT NULL REFERENCES users(id), imported_at TEXT NOT NULL,
      UNIQUE(channel, transaction_id)
    );
    CREATE TABLE IF NOT EXISTS cash_events (
      id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
      type TEXT NOT NULL CHECK(type IN ('ADD','PAYOUT','DROP','REFUND')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_events (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      delta_milli INTEGER NOT NULL, type TEXT NOT NULL,
      reference_id TEXT, reason TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monthly_stock_counts (
      month TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
      opening_milli INTEGER CHECK(opening_milli >= 0),
      closing_milli INTEGER CHECK(closing_milli >= 0),
      updated_at TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY(month, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_monthly_stock_counts_product ON monthly_stock_counts(product_id, month);
    CREATE TABLE IF NOT EXISTS refund_requests (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
      requested_by TEXT NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','COMPLETED')),
      reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
      completed_by TEXT REFERENCES users(id), completed_at TEXT,
      refund_reference TEXT, restocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_active ON refund_requests(order_id) WHERE status IN ('PENDING','APPROVED','COMPLETED');
    CREATE INDEX IF NOT EXISTS idx_refunds_completed ON refund_requests(completed_at);
    CREATE TABLE IF NOT EXISTS exceptions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
      created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT REFERENCES users(id), resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status, created_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id),
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      details TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
  `);
  if (!db.prepare('PRAGMA table_info(payments)').all().some((column) => column.name === 'claimed_transaction_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN claimed_transaction_id TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_claim ON payments(channel,claimed_transaction_id) WHERE claimed_transaction_id IS NOT NULL');
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase, transaction } from './db.js';
import { createDailyBackup } from './backup.js';
import { procurementOverview, recordReceipt, saveSupplier } from './procurement.js';
import { monthlyStockReconciliation, saveMonthlyStockCounts } from './reconciliation.js';
import { weeklySpotChecks } from './spot_checks.js';
import {
  AppError, addCashEvent, adjustStock, audit, claimPaymentReference, closeShift, completeRefund, countStock,
  createOrder, currentShift, dashboard, decideOrder, decideRefund, getOrder,
  decideProductRequest, importProducts, importStatements, linkStatement, listAudit, listCashEvents,
  listOrders, listProducts, listShifts, openShift, payOrder, requestRefund,
  recordDrawerOpen, requestProduct, resolveException, saveProduct, shiftExpectedCash, voidOrder,
} from './domain.js';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_SECONDS = 12 * 60 * 60;
const failedLogins = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function errorResponse(res, error) {
  const status = error instanceof AppError ? error.status : 500;
  if (status === 500) console.error(error);
  json(res, status, { ok: false, error: status === 500 ? '服务器发生错误' : error.message });
}

async function bodyOf(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new AppError('请使用 JSON 请求', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) throw new AppError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new AppError('JSON 格式错误'); }
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function validPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new AppError('密码长度应为 10–128 位');
  return password;
}

function createUser(db, input, role, actorId = null) {
  const username = String(input.username || '').trim().toLowerCase();
  const displayName = String(input.displayName || '').trim();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new AppError('账号须为 3–32 位小写字母、数字或下划线');
  if (!displayName || displayName.length > 50) throw new AppError('姓名不能为空，且不能超过 50 字');
  const password = validPassword(input.password);
  const salt = randomBytes(16).toString('hex');
  const userId = randomUUID();
  transaction(db, () => {
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(userId, username, displayName, role, hashPassword(password, salt), salt, 1, new Date().toISOString());
    audit(db, actorId || userId, 'USER_CREATED', 'user', userId, { username, role });
  });
  return { id: userId, username, displayName, role };
}

function updateCashier(db, actorId, userId, input) {
  return transaction(db, () => {
    const cashier = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!cashier || cashier.role !== 'cashier') throw new AppError('收银员账号不存在', 404);
    let changed = false;
    if (typeof input.active === 'boolean') {
      db.prepare('UPDATE users SET active=? WHERE id=?').run(input.active ? 1 : 0, userId);
      if (!input.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      changed = true;
    }
    if (input.password !== undefined) {
      const password = validPassword(input.password);
      const salt = randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').run(hashPassword(password, salt), salt, userId);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      changed = true;
    }
    if (!changed) throw new AppError('没有需要修改的内容');
    audit(db, actorId, 'CASHIER_ACCOUNT_UPDATED', 'user', userId, { active: input.active, passwordReset: input.password !== undefined });
    return db.prepare('SELECT id,username,display_name,role,active,created_at FROM users WHERE id=?').get(userId);
  });
}

function sessionUser(db, req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('pos_session='));
  if (!cookie) return null;
  const token = cookie.slice('pos_session='.length);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return db.prepare("SELECT u.id,u.username,u.display_name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1").get(tokenHash, new Date().toISOString()) || null;
}

function requireUser(user, role = null) {
  if (!user) throw new AppError('请先登录', 401);
  if (role && user.role !== role) throw new AppError('没有操作权限', 403);
  return user;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = process.env.POS_PUBLIC_ORIGIN || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (origin !== expected) throw new AppError('来源不匹配', 403);
}

function ownOrder(user, order) {
  if (user.role !== 'owner' && order.user_id !== user.id) throw new AppError('只能查看自己的订单', 403);
  return order;
}

async function staticFile(req, res, path) {
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'customer.html', 'customer.js', 'zxing-browser.min.js'].includes(file)) throw new AppError('页面不存在', 404);
  const content = await readFile(join(here, 'public', file));
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(content);
}

export function createApp({ db = openDatabase(process.env.POS_DB_PATH || join(here, 'data/pos.sqlite')), setupToken = process.env.POS_SETUP_TOKEN || randomBytes(12).toString('hex') } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError('请求方法不支持', 405);
        await staticFile(req, res, path);
        return;
      }
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) sameOrigin(req);
      const user = sessionUser(db, req);
      const initialized = db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0;
      if (req.method === 'GET' && path === '/api/bootstrap') {
        json(res, 200, { ok: true, data: { initialized, user, shift: user ? currentShift(db, user.id) : null } });
        return;
      }
      if (req.method === 'POST' && path === '/api/setup') {
        if (initialized) throw new AppError('系统已初始化', 409);
        const input = await bodyOf(req);
        if (input.setupToken !== setupToken) throw new AppError('初始化口令错误', 403);
        const owner = createUser(db, input, 'owner');
        json(res, 201, { ok: true, data: owner });
        return;
      }
      if (req.method === 'POST' && path === '/api/login') {
        const input = await bodyOf(req);
        const username = String(input.username || '').trim().toLowerCase();
        const key = `${req.socket.remoteAddress}:${username}`;
        const previous = failedLogins.get(key);
        const attempt = previous && Date.now() - previous.since < 15 * 60 * 1000 ? previous : null;
        if (attempt && attempt.count >= 5 && Date.now() - attempt.since < 15 * 60 * 1000) throw new AppError('尝试次数过多，请 15 分钟后重试', 429);
        const candidate = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
        const dummyHash = Buffer.from(hashPassword('dummy-password', '00000000000000000000000000000000'), 'hex');
        const candidateHash = Buffer.from(candidate?.password_hash || dummyHash.toString('hex'), 'hex');
        const actualHash = Buffer.from(hashPassword(String(input.password || ''), candidate?.salt || '00000000000000000000000000000000'), 'hex');
        if (!candidate || !timingSafeEqual(candidateHash, actualHash) || (input.role && candidate.role !== input.role)) {
          failedLogins.set(key, { count: (attempt?.count || 0) + 1, since: attempt?.since || Date.now() });
          throw new AppError('账号或密码错误', 401);
        }
        failedLogins.delete(key);
        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash, candidate.id, new Date(Date.now() + SESSION_SECONDS * 1000).toISOString());
        audit(db, candidate.id, 'LOGIN', 'user', candidate.id);
        const secure = req.socket.encrypted || process.env.POS_PUBLIC_ORIGIN?.startsWith('https://') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `pos_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`);
        json(res, 200, { ok: true, data: { id: candidate.id, username: candidate.username, display_name: candidate.display_name, role: candidate.role } });
        return;
      }
      if (req.method === 'POST' && path === '/api/logout') {
        if (user) {
          const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('pos_session='));
          if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(cookie.slice('pos_session='.length)).digest('hex'));
        }
        res.setHeader('Set-Cookie', 'pos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        json(res, 200, { ok: true, data: null });
        return;
      }
      requireUser(user);
      if (req.method === 'GET' && path === '/api/products/by-barcode') { requireUser(user, 'owner'); const barcode = String(url.searchParams.get('barcode') || '').trim(); if (!barcode) throw new AppError('请提供商品条码'); return json(res, 200, { ok: true, data: db.prepare('SELECT p.*,c.latest_cost_cents FROM products p LEFT JOIN product_costs c ON c.product_id=p.id WHERE p.barcode=?').get(barcode) || null }); }
      if (req.method === 'GET' && path === '/api/products') return json(res, 200, { ok: true, data: listProducts(db, url.searchParams.get('q') || '', url.searchParams.get('limit'), user.role === 'owner') });
      if (req.method === 'POST' && path === '/api/product-requests') return json(res, 201, { ok: true, data: requestProduct(db, user.id, await bodyOf(req)) });
      let productRequestMatch = path.match(/^\/api\/product-requests\/([^/]+)\/decision$/);
      if (req.method === 'POST' && productRequestMatch) { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: decideProductRequest(db, user.id, productRequestMatch[1], await bodyOf(req)) }); }
      if (req.method === 'POST' && path === '/api/products') { requireUser(user, 'owner'); return json(res, 201, { ok: true, data: saveProduct(db, user.id, await bodyOf(req)) }); }
      if (req.method === 'POST' && path === '/api/products/import') { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: importProducts(db, user.id, input.rows) }); }
      let match = path.match(/^\/api\/products\/([^/]+)$/);
      if (req.method === 'PATCH' && match) { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: saveProduct(db, user.id, await bodyOf(req), match[1]) }); }
      match = path.match(/^\/api\/products\/([^/]+)\/stock$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: adjustStock(db, user.id, match[1], input.deltaMilli, input.reason) }); }
      match = path.match(/^\/api\/products\/([^/]+)\/count$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: countStock(db, user.id, match[1], input.countedMilli, input.reason) }); }
      if (req.method === 'GET' && path === '/api/spot-checks') { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: weeklySpotChecks(db, url.searchParams.get('limit')) }); }
      if (req.method === 'GET' && path === '/api/procurement') { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: procurementOverview(db) }); }
      if (req.method === 'POST' && path === '/api/suppliers') { requireUser(user, 'owner'); return json(res, 201, { ok: true, data: saveSupplier(db, user.id, await bodyOf(req)) }); }
      match = path.match(/^\/api\/suppliers\/([^/]+)$/);
      if (req.method === 'PATCH' && match) { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: saveSupplier(db, user.id, await bodyOf(req), match[1]) }); }
      if (req.method === 'POST' && path === '/api/receipts') { requireUser(user, 'owner'); return json(res, 201, { ok: true, data: recordReceipt(db, user.id, await bodyOf(req)) }); }
      if (req.method === 'GET' && path === '/api/reconciliation/monthly') { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: monthlyStockReconciliation(db, url.searchParams.get('month')) }); }
      if (req.method === 'POST' && path === '/api/reconciliation/counts') { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: saveMonthlyStockCounts(db, user.id, input.month, input.rows) }); }
      if (req.method === 'GET' && path === '/api/users') { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: db.prepare('SELECT id,username,display_name,role,active,created_at FROM users ORDER BY created_at DESC').all() }); }
      if (req.method === 'POST' && path === '/api/users') { requireUser(user, 'owner'); return json(res, 201, { ok: true, data: createUser(db, await bodyOf(req), 'cashier', user.id) }); }
      match = path.match(/^\/api\/users\/([^/]+)$/);
      if (req.method === 'PATCH' && match) { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: updateCashier(db, user.id, match[1], await bodyOf(req)) }); }
      if (req.method === 'GET' && path === '/api/shifts') return json(res, 200, { ok: true, data: listShifts(db, user.role === 'owner' ? null : user.id) });
      if (req.method === 'GET' && path === '/api/shifts/current') return json(res, 200, { ok: true, data: currentShift(db, user.id) });
      if (req.method === 'POST' && path === '/api/shifts/open') { const input = await bodyOf(req); return json(res, 201, { ok: true, data: openShift(db, user.id, input.openingCashCents) }); }
      match = path.match(/^\/api\/shifts\/([^/]+)\/cash-events$/);
      if (req.method === 'GET' && match) { const shift = db.prepare('SELECT * FROM shifts WHERE id=?').get(match[1]); if (!shift || (user.role !== 'owner' && shift.user_id !== user.id)) throw new AppError('班次不存在', 404); return json(res, 200, { ok: true, data: listCashEvents(db, match[1]) }); }
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); return json(res, 201, { ok: true, data: addCashEvent(db, user.id, match[1], await bodyOf(req)) }); }
      match = path.match(/^\/api\/shifts\/([^/]+)\/drawer-open$/);
      if (req.method === 'POST' && match) { const input = await bodyOf(req); return json(res, 201, { ok: true, data: recordDrawerOpen(db, user.id, match[1], input.reason) }); }
      match = path.match(/^\/api\/shifts\/([^/]+)\/expected$/);
      if (req.method === 'GET' && match) { const shift = db.prepare('SELECT * FROM shifts WHERE id=?').get(match[1]); if (!shift || (user.role !== 'owner' && shift.user_id !== user.id)) throw new AppError('班次不存在', 404); if (user.role !== 'owner' && !shift.closed_at) throw new AppError('交班实点前不能查看应有现金', 403); return json(res, 200, { ok: true, data: shiftExpectedCash(db, match[1]) }); }
      match = path.match(/^\/api\/shifts\/([^/]+)\/close$/);
      if (req.method === 'POST' && match) { const input = await bodyOf(req); return json(res, 200, { ok: true, data: closeShift(db, user.id, match[1], input.countedCashCents, input.note) }); }
      if (req.method === 'GET' && path === '/api/orders') return json(res, 200, { ok: true, data: listOrders(db).filter((order) => user.role === 'owner' || order.user_id === user.id) });
      if (req.method === 'POST' && path === '/api/orders') return json(res, 201, { ok: true, data: createOrder(db, user.id, await bodyOf(req)) });
      match = path.match(/^\/api\/orders\/([^/]+)$/);
      if (req.method === 'GET' && match) return json(res, 200, { ok: true, data: ownOrder(user, getOrder(db, match[1])) });
      match = path.match(/^\/api\/orders\/([^/]+)\/decision$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: decideOrder(db, user.id, match[1], input.approve === true, input.note) }); }
      match = path.match(/^\/api\/orders\/([^/]+)\/pay$/);
      if (req.method === 'POST' && match) { const order = ownOrder(user, getOrder(db, match[1])); const input = await bodyOf(req); return json(res, 200, { ok: true, data: payOrder(db, user.id, order.id, input.receivedCashCents) }); }
      match = path.match(/^\/api\/orders\/([^/]+)\/payment-reference$/);
      if (req.method === 'POST' && match) { const order = ownOrder(user, getOrder(db, match[1])); const input = await bodyOf(req); return json(res, 200, { ok: true, data: claimPaymentReference(db, user.id, order.id, input.transactionId) }); }
      match = path.match(/^\/api\/orders\/([^/]+)\/void$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: voidOrder(db, user.id, match[1], input.reason) }); }
      match = path.match(/^\/api\/orders\/([^/]+)\/refund$/);
      if (req.method === 'POST' && match) { ownOrder(user, getOrder(db, match[1])); const input = await bodyOf(req); return json(res, 201, { ok: true, data: requestRefund(db, user.id, match[1], input.reason) }); }
      match = path.match(/^\/api\/refunds\/([^/]+)\/decision$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: decideRefund(db, user.id, match[1], input.approve === true) }); }
      match = path.match(/^\/api\/refunds\/([^/]+)\/complete$/);
      if (req.method === 'POST' && match) {
        const refund = db.prepare('SELECT r.*,o.method,o.user_id FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE r.id=?').get(match[1]);
        if (!refund || (user.role !== 'owner' && (refund.method !== 'cash' || refund.user_id !== user.id))) throw new AppError('没有完成此退款的权限', 403);
        const input = await bodyOf(req);
        return json(res, 200, { ok: true, data: completeRefund(db, user.id, match[1], input.reference, input.restock === true) });
      }
      if (req.method === 'GET' && path === '/api/dashboard') { requireUser(user, 'owner'); return json(res, 200, { ok: true, data: dashboard(db) }); }
      if (req.method === 'GET' && path === '/api/audit') return json(res, 200, { ok: true, data: listAudit(db, 100, user.role === 'owner' ? null : user.id) });
      if (req.method === 'POST' && path === '/api/statements/import') { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: importStatements(db, user.id, input.rows) }); }
      match = path.match(/^\/api\/statements\/([^/]+)\/link$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: linkStatement(db, user.id, match[1], input.orderId) }); }
      match = path.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);
      if (req.method === 'POST' && match) { requireUser(user, 'owner'); const input = await bodyOf(req); return json(res, 200, { ok: true, data: resolveException(db, user.id, match[1], input.resolution) }); }
      throw new AppError('接口不存在', 404);
    } catch (error) { errorResponse(res, error); }
  });
  return { server, db, setupToken };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.POS_HOST || '127.0.0.1';
  const port = Number(process.env.POS_PORT || 3100);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.POS_ALLOW_INSECURE_NETWORK !== '1') {
    console.error('默认仅允许本机监听。外网访问请先配置 HTTPS 反向代理；若仅在可信局域网演示，可设置 POS_ALLOW_INSECURE_NETWORK=1。');
    process.exit(1);
  }
  const { server, db, setupToken } = createApp();
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) console.log(`首次初始化口令：${setupToken}`);
  try { console.log(`数据库备份：${createDailyBackup(db)}`); } catch (error) { console.error('数据库备份失败：', error); }
  setInterval(() => { try { createDailyBackup(db); } catch (error) { console.error('数据库备份失败：', error); } }, 60 * 60 * 1000).unref();
  server.listen(port, host, () => console.log(`超市收银系统已启动：http://${host}:${port}`));
}

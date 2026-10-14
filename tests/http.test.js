import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { createApp } from '../server.js';

test('HTTP flow enforces cashier permissions and verifies digital payment from owner statement', async () => {
  const db = openDatabase(':memory:');
  const { server } = createApp({ db, setupToken: 'test-setup-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await call('/bootstrap')).data.data.initialized, false);
    assert.equal((await call('/setup', { method: 'POST', body: { setupToken: 'wrong', username: 'owner', displayName: '店主', password: 'safe-test-password' } })).status, 403);
    assert.equal((await call('/setup', { method: 'POST', body: { setupToken: 'test-setup-token', username: 'owner', displayName: '店主', password: 'safe-test-password' } })).status, 201);
    const ownerLogin = await call('/login', { method: 'POST', body: { username: 'owner', password: 'safe-test-password' } });
    assert.equal(ownerLogin.status, 200);
    const owner = ownerLogin.cookie;
    assert.equal((await call('/products', { method: 'POST', cookie: owner, body: { barcode: '1234', name: '矿泉水', unit: 'piece', priceCents: 250, stockMilli: 20000 } })).status, 201);
    const product = (await call('/products', { cookie: owner })).data.data.items[0];
    assert.equal((await call('/users', { method: 'POST', cookie: owner, body: { username: 'cashier', displayName: '小李', password: 'cashier-test-password' } })).status, 201);
    const cashierLogin = await call('/login', { method: 'POST', body: { username: 'cashier', password: 'cashier-test-password' } });
    const cashier = cashierLogin.cookie;
    assert.equal((await call('/products', { method: 'POST', cookie: cashier, body: { barcode: '9999', name: '私加商品', unit: 'piece', priceCents: 1 } })).status, 403);
    const openedShift = await call('/shifts/open', { method: 'POST', cookie: cashier, body: { openingCashCents: 10000 } });
    assert.equal(openedShift.status, 201);
    assert.equal((await call(`/shifts/${openedShift.data.data.id}/expected`, { cookie: cashier })).status, 403);
    assert.equal((await call(`/shifts/${openedShift.data.data.id}/expected`, { cookie: owner })).status, 200);
    const created = await call('/orders', { method: 'POST', cookie: cashier, body: { method: 'wechat', items: [{ productId: product.id, quantityMilli: 2000 }] } });
    assert.equal(created.status, 201);
    const orderId = created.data.data.id;
    assert.equal((await call(`/orders/${orderId}/pay`, { method: 'POST', cookie: cashier, body: {} })).data.data.status, 'PAYMENT_PENDING');
    assert.equal((await call('/statements/import', { method: 'POST', cookie: cashier, body: { rows: [] } })).status, 403);
    const imported = await call('/statements/import', { method: 'POST', cookie: owner, body: { rows: [{ channel: 'wechat', transactionId: 'WX-HTTP-1', orderId, amountCents: 500, status: 'SUCCESS', paidAt: new Date().toISOString() }] } });
    assert.equal(imported.data.data.matched, 1);
    assert.equal((await call(`/orders/${orderId}`, { cookie: cashier })).data.data.status, 'COMPLETED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

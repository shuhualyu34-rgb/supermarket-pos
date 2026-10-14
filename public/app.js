const app = document.querySelector('#app');
const customerChannel = new BroadcastChannel('supermarket-pos-cart');
const state = {
  initialized: false, user: null, shift: null, tab: 'pos', loginRole: 'cashier', notice: null,
  cart: [], products: [], productTotal: 0, searchResults: [], searchText: '',
  orders: [], selectedOrder: null, dashboard: null, shifts: [], users: [], audit: [], procurement: null,
  dashboardUpdatedAt: null, dashboardRefreshError: null, dashboardRefreshing: false,
  selectedMonth: null,
  productQuery: '', missingBarcode: null, pendingAddBarcode: null, busy: false,
};
let cameraScan = null;
let zxingLoad = null;
let dashboardRefreshTimer = null;
let receiptLineSeq = 0;
const DASHBOARD_REFRESH_MS = 10_000;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const date = (value) => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
const shortId = (value) => String(value || '').slice(0, 8).toUpperCase();
const qtyText = (milli, unit) => unit === 'kg' ? `${(milli / 1000).toFixed(3)} kg` : `${milli / 1000} 件`;
const methodName = { cash: '现金', wechat: '微信', alipay: '支付宝' };
const statusMap = {
  AWAITING_APPROVAL: ['待审批', 'warning'], AWAITING_PAYMENT: ['待收款', 'info'],
  PAYMENT_PENDING: ['待核实付款', 'warning'], COMPLETED: ['已完成', 'success'],
  VOIDED: ['已取消', 'neutral'], REFUNDED: ['已退款', 'neutral'],
};
const badge = (status) => { const [label, tone] = statusMap[status] || [status, 'neutral']; return `<span class="status ${tone}">${label}</span>`; };

function centsFromYuan(value, label = '金额') {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}请输入元，最多两位小数`);
  const [yuan, fraction = ''] = text.split('.');
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`${label}过大`);
  return cents;
}

function quantityFromInput(value, unit, allowZero = false) {
  const text = String(value ?? '').trim();
  const pattern = unit === 'kg' ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/;
  if (!pattern.test(text)) throw new Error(unit === 'kg' ? '重量最多保留三位小数' : '件数必须是整数');
  const milli = Math.round(Number(text) * 1000);
  if (!Number.isSafeInteger(milli) || (allowZero ? milli < 0 : milli <= 0)) throw new Error(allowZero ? '数量不能小于零' : '数量必须大于零');
  return milli;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET', credentials: 'same-origin',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: '服务器响应无效' }));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload.data;
}

async function run(action, success = '操作已完成') {
  if (state.busy) return;
  state.busy = true;
  state.notice = null;
  try {
    await action();
    if (!state.notice) state.notice = { type: 'success', text: success };
  } catch (error) {
    state.notice = { type: 'error', text: error.message };
  } finally {
    state.busy = false;
    render();
  }
}

async function bootstrap() {
  try {
    const data = await api('/bootstrap');
    state.initialized = data.initialized;
    state.user = data.user;
    state.shift = data.shift;
    if (state.user) await loadTab();
    render();
  } catch (error) {
    app.innerHTML = `<main class="auth-panel"><div class="banner">无法连接服务：${esc(error.message)}</div></main>`;
  }
}

async function loadTab() {
  if (!state.user) return;
  const tab = state.tab;
  if (tab === 'pos') {
    const result = await api('/products?limit=80');
    state.searchResults = result.items;
    state.products = result.items;
    state.productTotal = result.total;
  }
  if (tab === 'orders') {
    state.orders = await api('/orders');
    if (state.selectedOrder) state.selectedOrder = await api(`/orders/${state.selectedOrder.id}`);
  }
  if (tab === 'shift') state.shifts = await api('/shifts');
  if (tab === 'dashboard' && state.user.role === 'owner') {
    state.dashboard = await api('/dashboard');
    state.dashboardUpdatedAt = new Date();
    state.dashboardRefreshError = null;
  }
  if (tab === 'products') {
    const result = await api(`/products?q=${encodeURIComponent(state.productQuery)}&limit=100`);
    state.products = result.items;
    state.productTotal = result.total;
  }
  if (tab === 'team' && state.user.role === 'owner') state.users = await api('/users');
  if (tab === 'procurement' && state.user.role === 'owner') state.procurement = await api('/procurement');
  if (tab === 'audit') state.audit = await api('/audit');
  state.shift = await api('/shifts/current');
}

function noticeHtml() {
  if (!state.notice) return '';
  return `<div class="notice ${state.notice.type}" role="status"><span>${esc(state.notice.text)}</span><button type="button" data-action="dismiss-notice" aria-label="关闭提示">关闭</button></div>`;
}

function renderAuth() {
  const setup = !state.initialized;
  const roleLabel = state.loginRole === 'owner' ? '店主' : '员工';
  return `
    <div class="auth-page">
      <div class="auth-intro">
        <div class="brand"><div class="brand-mark" aria-hidden="true">有</div><div><strong>有数收银</strong><span>Retail operations</span></div></div>
        <div><h1>每笔交易，<br>都能对得上。</h1><p>收银、班次现金、商品库存和渠道流水汇在同一个工作台。店主查看异常，员工专注结账。</p></div>
        <div class="meta">单店经营版 · 数据保存在本机数据库</div>
      </div>
      <div class="auth-panel"><form id="${setup ? 'setup-form' : 'login-form'}" class="auth-card">
        <div><p class="eyebrow">${setup ? '首次使用' : '欢迎回来'}</p><h2>${setup ? '创建店主账号' : `${roleLabel}登录`}</h2><p class="muted">${setup ? '初始化口令在启动服务的终端中显示。' : '选择身份并使用个人账号登录，交易会记录到当前登录人。'}</p></div>
        ${noticeHtml()}
        ${setup ? '' : `<div class="login-roles" role="group" aria-label="登录身份"><button type="button" data-login-role="cashier" class="${state.loginRole === 'cashier' ? 'active' : ''}" aria-pressed="${state.loginRole === 'cashier'}">员工登录</button><button type="button" data-login-role="owner" class="${state.loginRole === 'owner' ? 'active' : ''}" aria-pressed="${state.loginRole === 'owner'}">店主登录</button></div><input type="hidden" name="role" value="${state.loginRole}">`}
        ${setup ? `<div class="field"><label for="setup-token">初始化口令</label><input id="setup-token" name="setupToken" required autocomplete="off"></div>` : ''}
        ${setup ? `<div class="field"><label for="display-name">店主姓名</label><input id="display-name" name="displayName" required maxlength="50" autocomplete="name"></div>` : ''}
        <div class="field"><label for="username">账号</label><input id="username" name="username" required minlength="3" maxlength="32" autocomplete="username" autocapitalize="off"></div>
        <div class="field"><label for="password">密码</label><input id="password" name="password" type="password" required minlength="10" autocomplete="${setup ? 'new-password' : 'current-password'}"></div>
        <button class="btn primary wide" type="submit">${setup ? '完成初始化' : '登录'}</button>
        <p class="small-muted">${setup ? '密码至少 10 位。创建后请妥善保管账号。' : '账号无法登录时，请联系店主处理。'}</p>
      </form></div>
    </div>`;
}

function shell() {
  const owner = state.user.role === 'owner';
  const tabs = navigationTabs();
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark" aria-hidden="true">有</div><div><strong>有数收银</strong><span>Retail operations</span></div></div>
      <nav class="nav" aria-label="主导航">${tabs.map(([key, label]) => `<button type="button" data-nav="${key}" class="${state.tab === key ? 'active' : ''}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><small>${owner ? '店主' : '收银员'}账号</small><b>${esc(state.user.display_name)}</b><button type="button" data-action="logout">退出登录</button></div>
    </aside>
    <main class="main">${noticeHtml()}${page()}</main>
  </div>`;
}

function navigationTabs() {
  return [
    ['pos', '收银台'], ['orders', '订单与退款'], ['shift', '班次与现金'],
    ...(state.user?.role === 'owner' ? [['dashboard', '店主总览']] : []),
    ['products', '商品与库存'],
    ...(state.user?.role === 'owner' ? [['procurement', '采购与供货']] : []),
    ...(state.user?.role === 'owner' ? [['team', '员工账号']] : []),
    ['audit', '操作记录'],
  ];
}

function header(eyebrow, title, subtitle = '', action = '') {
  return `<div class="topline"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${subtitle ? `<p class="subtext">${subtitle}</p>` : ''}</div><div class="top-actions">${action}</div></div>`;
}

function page() {
  if (!navigationTabs().some(([key]) => key === state.tab)) return renderPos();
  switch (state.tab) {
    case 'pos': return renderPos();
    case 'orders': return renderOrders();
    case 'shift': return renderShift();
    case 'dashboard': return renderDashboard();
    case 'products': return renderProducts();
    case 'procurement': return renderProcurement();
    case 'team': return renderTeam();
    case 'audit': return renderAudit();
    default: return '';
  }
}

function cartSubtotal() { return state.cart.reduce((sum, item) => sum + Math.round(item.unitPriceCents * item.quantityMilli / 1000), 0); }
function cartHtml() {
  if (!state.cart.length) return '<div class="empty">购物车还没有商品。扫描条码或在左侧搜索商品。</div>';
  return `<div class="cart-list">${state.cart.map((item, index) => `<div class="cart-item">
    <div><span class="cart-name">${esc(item.product.name)}</span><small>${esc(item.product.barcode)} · 目录价 ${money(item.product.price_cents)}/${item.product.unit === 'kg' ? 'kg' : '件'}</small>
      <div class="cart-controls"><label>数量${item.product.unit === 'kg' ? '(kg)' : '(件)'}<input data-cart-qty="${index}" inputmode="decimal" value="${item.quantityMilli / 1000}" aria-label="${esc(item.product.name)}数量"></label>
      <label>成交单价(元)<input data-cart-price="${index}" inputmode="decimal" value="${(item.unitPriceCents / 100).toFixed(2)}" aria-label="${esc(item.product.name)}成交单价"></label></div>
    </div><div class="stack tight" style="justify-items:end"><strong>${money(Math.round(item.unitPriceCents * item.quantityMilli / 1000))}</strong><button class="btn text small" type="button" data-remove-item="${index}">移除</button></div>
  </div>`).join('')}</div>`;
}

function searchResultsHtml() {
  if (!state.searchResults.length) return '<div class="empty">未找到商品。检查条码，或让店主先录入商品。</div>';
  return state.searchResults.map((item) => `<button type="button" class="search-result" data-add-product="${esc(item.id)}"><span><b>${esc(item.name)}</b><small>${esc(item.barcode)} · 库存 ${qtyText(item.stock_milli, item.unit)}</small></span><strong>${money(item.price_cents)}</strong></button>`).join('');
}

function renderPos() {
  const shiftPill = state.shift ? `<span class="status success">班次进行中 · ${time(state.shift.opened_at)}</span>` : '<span class="status warning">尚未开班</span>';
  return `${header('收银操作', '快速收银', '扫码枪扫描条码后自动加购，也可用手机摄像头扫描。', shiftPill + '<a class="btn secondary" href="/customer.html" target="_blank" rel="noopener">打开顾客屏</a>')}
    ${!state.shift ? `<div class="banner"><strong>开始收银前请先开班</strong>每名员工使用自己的班次和现金抽屉。<div class="row" style="margin-top:12px"><button class="btn dark" type="button" data-nav="shift">前往开班</button></div></div>` : ''}
    <div class="pos-grid" style="margin-top:${state.shift ? 0 : 18}px">
      <div class="card"><div class="card-heading"><div><h2>扫描或搜索商品</h2><p>输入条码、名称，支持约 3000 个 SKU</p></div><span class="pill">商品总数 ${state.productTotal}</span></div>
        <div class="card-body"><div class="field"><label for="product-search">条码 / 商品名称</label><input class="search-input" id="product-search" autocomplete="off" placeholder="扫描条码，或输入商品名称" value="${esc(state.searchText)}"></div><div class="row scan-actions"><button class="btn secondary small" type="button" data-camera-scan="pos">打开摄像头扫码</button><span class="small-muted">扫码枪对准条码即可自动加入；也可输入名称选择商品。</span></div>
          ${state.missingBarcode ? `<div class="banner info" style="margin-top:12px"><strong>新条码：${esc(state.missingBarcode)}</strong>${state.user.role === 'owner' ? `<p>先补商品资料，保存后会自动加入当前购物车。</p><button class="btn dark small" type="button" data-new-product-barcode="${esc(state.missingBarcode)}" style="margin-top:10px">立即建档并加购</button>` : `<p>请填写包装上的名称和货架售价，提交店主审核。批准后重新扫描即可销售。</p><form id="product-request-form" class="stack" style="margin-top:10px"><input type="hidden" name="barcode" value="${esc(state.missingBarcode)}"><div class="field"><label for="request-product-name">商品名称</label><input id="request-product-name" name="name" required maxlength="120"></div><div class="field"><label for="request-product-price">建议售价（元）</label><input id="request-product-price" name="price" required inputmode="decimal"></div><button class="btn dark small" type="submit">提交店主审核</button></form>`}</div>` : ''}
          <div class="search-results" id="search-results">${searchResultsHtml()}</div></div></div>
      <div class="card"><div class="card-heading"><div><h2>当前订单</h2><p>${state.cart.length} 种商品</p></div><button class="btn text small" type="button" data-action="clear-cart" ${state.cart.length ? '' : 'disabled'}>清空</button></div>
        <div class="card-body">${cartHtml()}<div class="divider"></div>
        <form id="checkout-form" class="stack">
          <div class="money-line"><span>商品小计</span><strong>${money(cartSubtotal())}</strong></div>
          <div class="field"><label for="discount">整单折扣（元，需要店主审批）</label><input id="discount" name="discount" inputmode="decimal" value="0.00"></div>
          <div class="field"><label for="override-reason">改价 / 折扣原因</label><input id="override-reason" name="overrideReason" maxlength="200" placeholder="有改价或折扣时必填"></div>
          <div class="field"><label>支付方式</label><div class="method-group">
            <label><input type="radio" name="method" value="cash" checked>现金</label>
            <label><input type="radio" name="method" value="wechat">微信</label>
            <label><input type="radio" name="method" value="alipay">支付宝</label>
          </div></div>
          <button class="btn primary wide" type="submit" ${!state.shift || !state.cart.length ? 'disabled' : ''}>创建订单 · ${money(cartSubtotal())}</button>
          <p class="help">扫码订单创建后进入付款核实流程。当前未配置真实支付渠道，不会生成可付款二维码。</p>
        </form></div></div>
    </div>`;
}

function renderShift() {
  const current = state.shift;
  return `${header('班次管理', '开班与交班', '实点现金先录入，提交后才展示系统应有金额。', current ? '<span class="status success">当前已开班</span>' : '<span class="status neutral">当前未开班</span>')}
    <div class="grid two">
      <div class="card"><div class="card-heading"><h2>${current ? '当前班次' : '开始新班次'}</h2></div><div class="card-body">
        ${current ? `<div class="stack"><div class="info-pair"><span>开班时间</span><b>${time(current.opened_at)}</b></div><div class="info-pair"><span>备用金</span><b>${money(current.opening_cash_cents)}</b></div><button class="btn secondary small" type="button" data-drawer-open="${esc(current.id)}">登记非销售开钱箱</button>
        <form id="close-shift-form" class="stack" style="margin-top:12px"><div class="field"><label for="counted-cash">实点现金（元）</label><input id="counted-cash" name="countedCash" required inputmode="decimal" placeholder="清点后录入"></div><div class="field"><label for="closing-note">差异说明（如有）</label><textarea id="closing-note" name="note" placeholder="记录交班时发现的情况"></textarea></div><button class="btn dark" type="submit">提交交班</button></form></div>`
        : `<form id="open-shift-form" class="stack"><div class="field"><label for="opening-cash">备用金（元）</label><input id="opening-cash" name="openingCash" required inputmode="decimal" placeholder="例如 300.00"></div><button class="btn primary" type="submit">确认开班</button></form>`}
      </div></div>
      <div class="card"><div class="card-heading"><h2>现金核对规则</h2></div><div class="card-body stack"><p>应有现金 = 备用金 + 现金销售 + 现金补入 − 现金支出 − 现金入库 − 现金退款。</p><p class="subtext">每笔现金变动都需记明原因。系统保留实点额和差额，不能回头改历史订单消除差异。</p>${state.user.role === 'owner' ? `<form id="cash-event-form" class="stack" style="margin-top:12px"><div class="field"><label for="cash-event-shift">记录到班次</label><select id="cash-event-shift" name="shiftId" required><option value="">选择未结班次</option>${state.shifts.filter((shift) => !shift.closed_at).map((shift) => `<option value="${esc(shift.id)}">${esc(shift.cashier_name || state.user.display_name)} · ${time(shift.opened_at)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label for="cash-event-type">类型</label><select id="cash-event-type" name="type"><option value="ADD">补入现金</option><option value="PAYOUT">现金支出</option><option value="DROP">现金入库</option></select></div><div class="field"><label for="cash-event-amount">金额（元）</label><input id="cash-event-amount" name="amount" required inputmode="decimal"></div></div><div class="field"><label for="cash-event-reason">原因</label><input id="cash-event-reason" name="reason" required maxlength="200"></div><button class="btn secondary" type="submit">登记现金变动</button></form>` : ''}</div></div>
    </div>
    <div class="section-title"><h2>最近班次</h2></div>
    ${state.shifts.length ? `<div class="table-wrap"><table><thead><tr><th>员工 / 班次</th><th>时间</th><th>备用金</th><th>实点</th><th>应有</th><th>差额</th></tr></thead><tbody>${state.shifts.map((shift) => `<tr><td><strong>${esc(shift.cashier_name || state.user.display_name)}</strong><small>${shortId(shift.id)}</small></td><td>${time(shift.opened_at)}<small>${shift.closed_at ? `结束 ${time(shift.closed_at)}` : '进行中'}</small></td><td>${money(shift.opening_cash_cents)}</td><td>${shift.closed_at ? money(shift.counted_cash_cents) : '—'}</td><td>${shift.closed_at ? money(shift.expected_cash_cents) : '交班后可见'}</td><td>${shift.closed_at ? `<span class="status ${shift.discrepancy_cents ? 'warning' : 'success'}">${money(shift.discrepancy_cents)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">还没有班次记录。</div>'}`;
}

function renderOrders() {
  const selected = state.selectedOrder;
  return `${header('交易记录', '订单与退款', '所有订单保留原始记录；已付款订单通过退款处理。')}
    ${selected ? renderOrderDetail(selected) : ''}
    <div class="section-title"><h2>最近订单</h2><button class="btn secondary small" type="button" data-action="refresh-orders">刷新订单</button></div>
    ${state.orders.length ? `<div class="table-wrap"><table><thead><tr><th>订单</th><th>时间 / 收银员</th><th>支付</th><th>金额</th><th>状态</th><th></th></tr></thead><tbody>${state.orders.map((order) => `<tr><td><strong>${shortId(order.id)}</strong><small title="${esc(order.id)}">${esc(order.id)}</small></td><td>${time(order.created_at)}<small>${esc(order.cashier_name)}</small></td><td>${methodName[order.method]}</td><td><strong>${money(order.total_cents)}</strong></td><td>${badge(order.status)}</td><td><button type="button" class="link-button" data-open-order="${esc(order.id)}">查看</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">还没有订单。请先在收银台创建一笔交易。</div>'}`;
}

function renderOrderDetail(order) {
  const owner = state.user.role === 'owner';
  const mine = order.user_id === state.user.id;
  const canPay = mine && order.status === 'AWAITING_PAYMENT';
  const canRefund = order.status === 'COMPLETED' && (mine || owner);
  return `<section id="print-receipt"><div class="section-title"><h2>订单 ${shortId(order.id)}</h2><button class="btn text small" type="button" data-action="close-order">收起详情</button></div>
    <div class="detail-grid">
      <div class="card"><div class="card-heading"><div><h2>商品明细</h2><p>完整订单号：${esc(order.id)}</p></div>${badge(order.status)}</div><div class="card-body">
        ${order.items.map((item) => `<div class="info-pair"><span>${esc(item.name)}<small> ${qtyText(item.quantity_milli, item.unit)} × ${money(item.unit_price_cents)}</small></span><b>${money(item.line_cents)}</b></div>`).join('')}
        <div class="divider"></div><div class="info-pair"><span>商品小计</span><b>${money(order.subtotal_cents)}</b></div><div class="info-pair"><span>整单折扣</span><b>−${money(order.discount_cents)}</b></div><div class="info-pair"><span>应付金额</span><b class="money-total">${money(order.total_cents)}</b></div>
        ${order.override_reason ? `<div class="banner" style="margin-top:14px"><strong>改价 / 折扣原因</strong>${esc(order.override_reason)}</div>` : ''}
      </div></div>
      <div class="stack">
        <div class="card"><div class="card-heading"><h2>支付与处理</h2></div><div class="card-body stack">
          <div class="info-pair"><span>支付方式</span><b>${methodName[order.method]}</b></div><div class="info-pair"><span>收银员</span><b>${esc(order.cashier_name)}</b></div><div class="info-pair"><span>创建时间</span><b>${time(order.created_at)}</b></div>
          ${order.completed_at ? `<div class="info-pair"><span>完成时间</span><b>${time(order.completed_at)}</b></div>` : ''}
          ${order.payment?.transaction_id ? `<div class="info-pair"><span>渠道交易号</span><b>${esc(order.payment.transaction_id)}</b></div>` : ''}
          ${order.method === 'cash' && order.completed_at ? `<div class="info-pair"><span>现金实收 / 找零</span><b>${money(order.received_cash_cents)} / ${money(order.change_cents)}</b></div>` : ''}
          ${order.status === 'AWAITING_APPROVAL' ? `<div class="banner"><strong>等待店主审批</strong>改价或折扣获批后才能收款。</div>${owner ? `<div class="row"><button class="btn primary" type="button" data-order-decision="approve" data-id="${esc(order.id)}">批准</button><button class="btn danger" type="button" data-order-decision="reject" data-id="${esc(order.id)}">拒绝</button></div>` : ''}` : ''}
          ${canPay && order.method === 'cash' ? `<form id="cash-pay-form" class="stack"><input type="hidden" name="orderId" value="${esc(order.id)}"><div class="field"><label for="cash-received">实收现金（元）</label><input id="cash-received" name="received" inputmode="decimal" required placeholder="至少 ${money(order.total_cents)}"></div><button class="btn primary" type="submit">确认现金收款</button></form>` : ''}
          ${canPay && order.method !== 'cash' ? `<div class="banner"><strong>扫码支付尚未接入真实渠道</strong>请使用店铺自己的商户收款工具收款。随后由店主导入渠道交易流水或手动核对交易号；在此之前订单不会标记为到账。</div><button class="btn dark" type="button" data-digital-pending="${esc(order.id)}">登记为待核实付款</button>` : ''}
          ${order.status === 'PAYMENT_PENDING' ? `<div class="banner"><strong>等待渠道流水核实</strong>当前使用固定收款码。可记录顾客付款详情中的渠道交易号，店主导入渠道账单后按交易号、渠道和金额核对；截图不能单独作为到账凭证。</div>${order.payment?.claimed_transaction_id ? `<div class="info-pair"><span>员工登记的交易号（未核实）</span><b>${esc(order.payment.claimed_transaction_id)}</b></div>` : ''}${mine ? `<form id="payment-reference-form" class="stack"><input type="hidden" name="orderId" value="${esc(order.id)}"><div class="field"><label for="claimed-transaction-id">顾客付款详情中的渠道交易号</label><input id="claimed-transaction-id" name="transactionId" required maxlength="120" value="${esc(order.payment?.claimed_transaction_id || '')}" autocomplete="off"><small>这只是待核对线索，保存后仍会显示“待核实付款”。</small></div><button class="btn secondary" type="submit">记录交易号</button></form>` : ''}` : ''}
          ${owner && ['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(order.status) ? `<button class="btn danger" type="button" data-order-void="${esc(order.id)}">取消订单</button>` : ''}
          ${canRefund ? `<form id="refund-request-form" class="stack"><input type="hidden" name="orderId" value="${esc(order.id)}"><div class="field"><label for="refund-reason">全额退款原因</label><input id="refund-reason" name="reason" required maxlength="200"></div><button class="btn secondary" type="submit">提交退款申请</button></form>` : ''}
          ${order.refund ? renderRefund(order) : ''}
          ${['COMPLETED', 'REFUNDED'].includes(order.status) ? `<button class="btn text" type="button" data-action="print">打印订单</button>` : ''}
        </div></div>
      </div>
    </div></section>`;
}

function renderRefund(order) {
  const refund = order.refund;
  const owner = state.user.role === 'owner';
  return `<div class="divider"></div><div class="stack"><h3>全额退款</h3><p class="subtext">${esc(refund.reason)} · ${refund.status === 'PENDING' ? '待审批' : refund.status === 'APPROVED' ? '已批准，待完成' : refund.status === 'REJECTED' ? '已拒绝' : '已完成'}</p>
    ${refund.status === 'PENDING' && owner ? `<div class="row"><button class="btn primary small" type="button" data-refund-decision="approve" data-id="${esc(refund.id)}">批准</button><button class="btn danger small" type="button" data-refund-decision="reject" data-id="${esc(refund.id)}">拒绝</button></div>` : ''}
    ${refund.status === 'APPROVED' && (owner || (order.method === 'cash' && order.user_id === state.user.id)) ? `<form id="refund-complete-form" class="stack"><input type="hidden" name="refundId" value="${esc(refund.id)}"><div class="field"><label for="refund-reference">${order.method === 'cash' ? '现金退款备注' : '渠道退款流水号（确认已退款后填写）'}</label><input id="refund-reference" name="reference" ${order.method === 'cash' ? '' : 'required'} maxlength="120"></div><label class="row"><input type="checkbox" name="restock" style="width:auto;min-height:auto">退回商品可重新入库</label><button class="btn primary" type="submit">确认退款已完成</button></form>` : ''}
    ${refund.status === 'COMPLETED' ? `<p class="small-muted">完成于 ${time(refund.completed_at)} · 凭证 ${esc(refund.refund_reference || '—')}</p>` : ''}
  </div>`;
}

function renderMonthlyOverview(data) {
  const months = data.monthly || [];
  if (!months.length) return '';
  const selected = months.find((item) => item.month === state.selectedMonth) || months.at(-1);
  const maxGross = Math.max(1, ...months.map((item) => item.grossCents));
  const monthLabel = (value) => `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月`;
  return `<section class="dashboard-monthly" aria-labelledby="monthly-title">
    <div class="dashboard-monthly-heading"><div><p class="eyebrow">近 13 个月 · 含本月</p><h2 id="monthly-title">每月经营情况</h2><p>点击月份查看明细。当月数据每 10 秒自动更新。</p></div><span class="pill">${esc(monthLabel(selected.month))}</span></div>
    <div class="dashboard-monthly-layout">
      <div class="monthly-list" role="group" aria-label="选择查看月份">${months.slice().reverse().map((item) => `<button type="button" class="monthly-row ${item.month === selected.month ? 'active' : ''}" data-dashboard-month="${item.month}" aria-pressed="${item.month === selected.month}"><span class="monthly-label">${esc(monthLabel(item.month))}${item.month === data.today.slice(0, 7) ? '<small>本月</small>' : ''}</span><span class="monthly-track"><span class="monthly-bar-${item.grossCents ? Math.max(1, Math.round(item.grossCents / maxGross * 10)) : 0}"></span></span><strong>${money(item.grossCents)}</strong></button>`).join('')}</div>
      <div class="monthly-detail"><h3>${esc(monthLabel(selected.month))}明细</h3><div class="monthly-totals"><div><span>收款总额</span><strong>${money(selected.grossCents)}</strong></div><div><span>退款总额</span><strong>${money(selected.refundCents)}</strong></div><div><span>收款净额</span><strong>${money(selected.netCents)}</strong></div><div><span>完成订单</span><strong>${selected.orderCount} 笔</strong></div></div><div class="monthly-breakdown"><div><span>现金</span><b>${money(selected.cashCents)}</b></div><div><span>微信</span><b>${money(selected.wechatCents)}</b></div><div><span>支付宝</span><b>${money(selected.alipayCents)}</b></div><div><span>已完成退款</span><b>${selected.refundCount} 笔</b></div><div><span>待核实扫码订单</span><b>${selected.pendingCount} 笔</b></div></div><p class="monthly-note">收款按完成时间计入，退款按实际完成月份扣减；待核实款不计入收款。</p></div>
    </div>
  </section>`;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return '<div class="empty">正在加载店主总览。</div>';
  const saleTotal = data.sales.reduce((sum, item) => sum + item.amount, 0);
  const saleCount = data.sales.reduce((sum, item) => sum + item.count, 0);
  const cash = data.sales.find((item) => item.method === 'cash')?.amount || 0;
  const approvals = [
    ...data.approvals.map((item) => ({
      id: item.entity_id,
      title: item.kind === 'PRICE' ? '改价 / 折扣订单' : '退款申请',
      meta: `订单 ${item.order_id}`,
      amount: money(item.amount),
      time: item.time,
    })),
  ].sort((a, b) => new Date(b.time) - new Date(a.time));
  const statements = data.statements || [];
  const statementCount = data.statementSummary?.count ?? statements.length;
  const statementTotal = data.statementSummary?.amount ?? statements.reduce((sum, item) => sum + item.amount_cents, 0);
  const exceptions = data.exceptions || [];
  const cashIssues = data.cashIssues || exceptions.filter((item) => item.kind === 'CASH_DIFFERENCE');
  const stockIssues = data.stockIssues || exceptions.filter((item) => ['STOCK_DIFFERENCE', 'NEGATIVE_STOCK'].includes(item.kind));
  const otherIssues = data.otherIssues || exceptions.filter((item) => !['CASH_DIFFERENCE', 'STOCK_DIFFERENCE', 'NEGATIVE_STOCK'].includes(item.kind));
  const cashIssueCount = data.cashIssueSummary?.count ?? data.exceptionCounts?.CASH_DIFFERENCE ?? cashIssues.length;
  const cashIssueAmount = data.cashIssueSummary?.absolute_amount ?? cashIssues.reduce((sum, item) => sum + Math.abs(item.discrepancy_cents || 0), 0);
  const stockIssueCount = (data.exceptionCounts?.STOCK_DIFFERENCE ?? stockIssues.filter((item) => item.kind === 'STOCK_DIFFERENCE').length)
    + (data.exceptionCounts?.NEGATIVE_STOCK ?? stockIssues.filter((item) => item.kind === 'NEGATIVE_STOCK').length);
  const otherIssueCount = data.exceptionCounts
    ? Object.entries(data.exceptionCounts).filter(([kind]) => !['CASH_DIFFERENCE', 'STOCK_DIFFERENCE', 'NEGATIVE_STOCK'].includes(kind)).reduce((sum, [, count]) => sum + count, 0)
    : otherIssues.length;
  const productRequestCount = data.productRequestCount ?? data.productRequests.length;
  const approvalCount = data.approvals.length + productRequestCount;
  const metric = (label, value, detail, tone = 'neutral') => `<article class="stat dashboard-stat ${tone === 'neutral' ? '' : `is-${tone}`}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-meta">${detail}</div></article>`;
  const section = (title, count, content, description = '') => `<section class="dashboard-section"><div class="dashboard-section-heading"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div><span class="pill">${count}</span></div>${content}</section>`;
  const rows = (items, renderRow, emptyText, limit = 6) => items.length
    ? `<div class="dashboard-list">${items.slice(0, limit).map(renderRow).join('')}</div>${items.length > limit ? `<p class="dashboard-more">列表显示前 ${limit} 项</p>` : ''}`
    : `<div class="empty dashboard-empty">${emptyText}</div>`;
  const dashboardError = state.dashboardRefreshError ? `<p class="dashboard-refresh-error" role="status">自动刷新失败：${esc(state.dashboardRefreshError)}。仍显示上次成功数据。</p>` : '';

  return `<div class="dashboard-page">
    <div class="topline dashboard-topline"><div><p class="eyebrow">店主 · 经营总览</p><h1>经营总览</h1><p class="subtext">查看每月收款和需要核对的经营异常。</p></div>
      <div class="dashboard-refresh"><span class="pill">数据日期 ${esc(data.today)}</span><button class="btn secondary dashboard-refresh-button" type="button" data-action="refresh-dashboard" ${state.dashboardRefreshing ? 'disabled aria-busy="true"' : ''}>${state.dashboardRefreshing ? '刷新中…' : '刷新'}</button><span class="dashboard-updated">${state.dashboardUpdatedAt ? `更新于 ${time(state.dashboardUpdatedAt)}` : '等待更新'}</span></div>
    </div>
    ${dashboardError}
    <div class="dashboard-metrics" aria-label="待关注指标">
      ${metric('待审批', `${approvalCount} 项`, `含商品申请 ${productRequestCount} 项`, approvalCount ? 'warning' : 'neutral')}
      ${metric('待核实付款', `${data.pending.count} 笔`, `合计 ${money(data.pending.amount)}`, data.pending.count ? 'warning' : 'neutral')}
      ${metric('渠道有款无单', `${statementCount} 笔`, `合计 ${money(statementTotal)}`, statementCount ? 'danger' : 'neutral')}
      ${metric('现金差额', `${cashIssueCount} 项`, cashIssueCount ? `差额绝对值合计 ${money(cashIssueAmount)}` : '没有未结差额', cashIssueCount ? 'danger' : 'neutral')}
      ${metric('库存差异', `${stockIssueCount} 项`, `抽盘差异与负库存`, stockIssueCount ? 'warning' : 'neutral')}
    </div>
    ${renderMonthlyOverview(data)}
    <div class="dashboard-groups">
      ${section('订单 / 退款审批', `${approvals.length} 项`, rows(approvals, (item) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${esc(item.title)}</strong><p>${esc(item.meta)} · ${time(item.time)}</p></div><b class="dashboard-row-value">${esc(item.amount)}</b></article>`, '目前没有订单或退款审批。'))}
      ${data.productRequests.length ? `<div class="dashboard-section dashboard-subsection"><div class="dashboard-section-heading"><div><h3>新商品建档</h3><p>核对员工提交的条码与建议资料</p></div><span class="pill">${productRequestCount} 项</span></div>${rows(data.productRequests.map((item) => ({ ...item, time: item.created_at })), (item) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${esc(item.suggested_name)}</strong><p>${esc(item.barcode)} · ${esc(item.requester_name)} · ${time(item.created_at)}</p></div><b class="dashboard-row-value">${money(item.suggested_price_cents)}</b></article>`, '没有待审核的新商品。')}</div>` : ''}
      ${section('待核实付款', `${data.pending.count} 笔`, rows(data.pendingOrders, (order) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${methodName[order.method]} · 待核实</strong><p>订单 ${esc(order.id)} · ${esc(order.cashier_name)} · ${time(order.created_at)}</p></div><b class="dashboard-row-value">${money(order.total_cents)}</b></article>`, '没有待核实的扫码订单。'))}
      ${section('渠道有款无单', `${statementCount} 笔`, rows(statements, (item) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${methodName[item.channel]} · ${esc(item.transaction_id)}</strong><p>${time(item.paid_at)} · 渠道流水尚未匹配本系统订单</p></div><b class="dashboard-row-value">${money(item.amount_cents)}</b></article>`, '没有未匹配的渠道流水。'))}
      ${section('现金差额', `${cashIssueCount} 项`, rows(cashIssues, (item) => {
        return `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${esc(item.description)}</strong><p>${item.cashier_name ? `${esc(item.cashier_name)} · ${item.closed_at ? '已交班' : '进行中'} · ` : ''}${time(item.created_at)}</p></div>${item.discrepancy_cents !== null && item.discrepancy_cents !== undefined ? `<b class="dashboard-row-value">${money(item.discrepancy_cents)}</b>` : ''}</article>`;
      }, '目前没有未结现金差额。'))}
      ${section('库存差异', `${stockIssueCount} 项`, rows(stockIssues, (item) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${esc(item.description)}</strong><p>${item.kind === 'STOCK_DIFFERENCE' ? '抽盘差异' : '负库存'} · ${time(item.created_at)} · ${item.severity === 'HIGH' ? '优先核对' : '待复核'}</p></div></article>`, '目前没有未结库存差异。'))}
      ${otherIssueCount ? section('其他未结异常', `${otherIssueCount} 项`, rows(otherIssues, (item) => `<article class="dashboard-row"><div class="dashboard-row-main"><strong>${esc(item.description)}</strong><p>${time(item.created_at)} · ${esc(item.kind)} · ${item.severity === 'HIGH' ? '优先核对' : '待复核'}</p></div></article>`, '没有其他异常。', 4)) : ''}
    </div>
    <section class="dashboard-sales" aria-label="今日经营概况">
      <div><span>今日收款</span><strong>${money(saleTotal)}</strong><small>${saleCount} 笔</small></div>
      <div><span>现金销售</span><strong>${money(cash)}</strong><small>按已完成订单统计</small></div>
      <div><span>今日退款</span><strong>${money(data.refundsToday)}</strong><small>按完成时间统计</small></div>
    </section>
    <p class="dashboard-readonly-note">此页只展示本地系统记录；渠道到账仍以已导入的真实渠道流水为准。</p>
  </div>`;
}

function renderProducts() {
  if (state.user.role !== 'owner') return `${header('商品查询', '商品与库存', `已录入 ${state.productTotal} 个在售 SKU。员工可查询商品资料，新增和修改请联系店主。`)}
    <div class="section-title"><h2>商品列表</h2><div class="field" style="width:min(320px,100%)"><label for="catalog-search">搜索商品</label><input id="catalog-search" value="${esc(state.productQuery)}" placeholder="名称或条码"></div></div>
    ${state.products.length ? `<div class="table-wrap"><table><thead><tr><th>条码</th><th>商品</th><th>售价</th><th>当前库存</th></tr></thead><tbody>${state.products.map((product) => `<tr><td>${esc(product.barcode)}</td><td><strong>${esc(product.name)}</strong><small>${product.unit === 'kg' ? '按千克' : '按件'}</small></td><td>${money(product.price_cents)}</td><td>${qtyText(product.stock_milli, product.unit)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无商品，请联系店主录入。</div>'}`;
  return `${header('商品管理', '商品与库存', `已录入 ${state.productTotal} 个在售 SKU。批量导入时已有商品的库存不会被覆盖。`)}
    <div class="grid two">
      <div class="card"><div class="card-heading"><h2>新增 / 编辑商品</h2></div><div class="card-body"><form id="product-form" class="stack"><input type="hidden" name="productId"><div class="form-grid"><div class="field"><label for="product-barcode">条码</label><input id="product-barcode" name="barcode" required maxlength="64" autocomplete="off"><small id="product-barcode-status">扫码枪可直接扫描；已有条码会带出本店商品资料。</small></div><div class="field"><label for="product-name">商品名称</label><input id="product-name" name="name" required maxlength="120"></div><div class="field"><label for="product-unit">单位</label><select id="product-unit" name="unit"><option value="piece">件</option><option value="kg">千克</option></select></div><div class="field"><label for="product-price">售价（元）</label><input id="product-price" name="price" required inputmode="decimal"></div><div class="field"><label for="product-cost">最近进货成本（元，店主可补录）</label><input id="product-cost" name="cost" inputmode="decimal" placeholder="未录入"></div><div class="field"><label for="product-stock">初始库存（新商品）</label><input id="product-stock" name="stock" inputmode="decimal" value="0"></div><div class="field"><label for="product-reason">变更原因</label><input id="product-reason" name="reason" maxlength="200" value="商品资料维护"></div></div><div class="row"><button class="btn secondary" type="button" data-camera-scan="catalog">打开摄像头扫条码</button><button class="btn primary" type="submit">保存商品</button><button class="btn text" type="button" data-action="clear-product-form">清空表单</button></div><p class="help">新条码会自动填入条码栏；名称和店铺售价请按商品资料填写。已有商品会自动带出资料。</p></form></div></div>
      <div class="card"><div class="card-heading"><h2>批量导入商品</h2></div><div class="card-body stack"><p>先整理条码、名称、单位、售价和初始库存。导入后可立即用扫码枪检索。</p><div class="banner info"><strong>CSV 列格式</strong>barcode, name, unit, price_yuan, cost_yuan, stock。成本列可留空；重复条码会更新名称和售价，保留现有库存。</div><form id="product-import-form" class="stack"><div class="field"><label for="product-file">商品 CSV 文件</label><input id="product-file" name="file" type="file" accept=".csv,text/csv" required></div><div class="row"><button class="btn secondary" type="submit">导入商品</button><button class="btn text" type="button" data-download-template="products">下载模板</button></div></form></div></div>
    </div>
    <div class="section-title"><h2>商品列表</h2><div class="field" style="width:min(320px,100%)"><label for="catalog-search">搜索商品</label><input id="catalog-search" value="${esc(state.productQuery)}" placeholder="名称或条码"></div></div>
    ${state.products.length ? `<div class="table-wrap"><table><thead><tr><th>条码</th><th>商品</th><th>售价</th><th>最近进货成本</th><th>当前库存</th><th>库存估值</th><th>操作</th></tr></thead><tbody>${state.products.map((product) => `<tr><td>${esc(product.barcode)}</td><td><strong>${esc(product.name)}</strong><small>${product.unit === 'kg' ? '按千克' : '按件'}</small></td><td>${money(product.price_cents)}</td><td>${product.latest_cost_cents == null ? '未录入' : money(product.latest_cost_cents)}</td><td>${qtyText(product.stock_milli, product.unit)}</td><td>${product.latest_cost_cents == null ? '—' : money(Math.round(Math.max(0, product.stock_milli) * product.latest_cost_cents / 1000))}</td><td><div class="row"><button class="link-button" type="button" data-edit-product="${esc(product.id)}">编辑</button><button class="link-button" type="button" data-adjust-stock="${esc(product.id)}">调整库存</button><button class="link-button" type="button" data-count-stock="${esc(product.id)}">抽盘</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无商品。可手动新增，或导入 3000 个 SKU 的 CSV。</div>'}`;
}

function receiptLineHtml() {
  const line = ++receiptLineSeq;
  return `<div class="receipt-line" data-receipt-line>
    <div class="field"><label for="receipt-barcode-${line}">商品条码</label><input id="receipt-barcode-${line}" name="receiptBarcode" data-receipt-barcode required maxlength="64" autocomplete="off" placeholder="扫码或输入条码"></div>
    <div class="field"><label for="receipt-quantity-${line}">到货数量</label><input id="receipt-quantity-${line}" name="receiptQuantity" required inputmode="decimal" placeholder="件数或千克数"></div>
    <div class="field"><label for="receipt-cost-${line}">进货单价（元）</label><input id="receipt-cost-${line}" name="receiptCost" required inputmode="decimal" placeholder="0.00"></div>
    <button class="btn text" type="button" data-action="remove-receipt-line">移除 / 清空</button>
    <p class="receipt-match" data-receipt-match>输入商品条码后显示名称与单位。</p>
  </div>`;
}

function renderProcurement() {
  const data = state.procurement;
  if (!data) return '<div class="empty">正在加载采购与供货资料。</div>';
  const activeSuppliers = data.suppliers.filter((supplier) => supplier.active);
  const summary = data.summary;
  return `${header('店主管理', '采购与供货', '登记供应商和到货成本；确认入库后自动增加商品库存。')}
    <div class="grid four procurement-stats">
      <div class="stat"><div class="stat-label">启用供应商</div><div class="stat-value">${activeSuppliers.length}</div></div>
      <div class="stat"><div class="stat-label">已有成本商品</div><div class="stat-value">${summary.costKnownCount}</div><div class="stat-meta">${summary.costUnknownCount} 个商品待补成本</div></div>
      <div class="stat"><div class="stat-label">库存估值</div><div class="stat-value">${money(summary.inventoryValueCents)}</div><div class="stat-meta">按最近进货成本估算，未录成本不计入</div></div>
      <div class="stat"><div class="stat-label">负库存商品</div><div class="stat-value">${summary.negativeStockCount}</div><div class="stat-meta">请在商品与库存中核对</div></div>
    </div>
    <div class="grid two procurement-forms">
      <section class="card"><div class="card-heading"><h2>供应商资料</h2></div><div class="card-body"><form id="supplier-form" class="stack"><input type="hidden" name="supplierId"><div class="field"><label for="supplier-name">供应商名称</label><input id="supplier-name" name="name" required maxlength="100"></div><div class="form-grid"><div class="field"><label for="supplier-contact">联系人</label><input id="supplier-contact" name="contactName" maxlength="60"></div><div class="field"><label for="supplier-phone">联系电话</label><input id="supplier-phone" name="phone" maxlength="40" inputmode="tel"></div></div><div class="field"><label for="supplier-notes">备注</label><textarea id="supplier-notes" name="notes" maxlength="300"></textarea></div><div class="field"><label for="supplier-active">状态</label><select id="supplier-active" name="active"><option value="true">启用</option><option value="false">停用</option></select></div><div class="row"><button class="btn primary" type="submit">保存供应商</button><button class="btn text" type="button" data-action="clear-supplier-form">新建另一家</button></div></form></div></section>
      <section class="card"><div class="card-heading"><h2>到货入库</h2></div><div class="card-body"><form id="receipt-form" class="stack"><div class="form-grid"><div class="field"><label for="receipt-supplier">供货商</label><select id="receipt-supplier" name="supplierId" required><option value="">选择供应商</option>${activeSuppliers.map((supplier) => `<option value="${esc(supplier.id)}">${esc(supplier.name)}</option>`).join('')}</select></div><div class="field"><label for="receipt-reference">供货单号（建议填写）</label><input id="receipt-reference" name="referenceNo" maxlength="80" placeholder="用于防止重复入库"></div></div><div class="field"><label for="receipt-note">到货备注</label><input id="receipt-note" name="note" maxlength="300" placeholder="例如批次、送货说明"></div><div id="receipt-lines" class="stack">${receiptLineHtml()}</div><div class="row"><button class="btn secondary" type="button" data-action="add-receipt-line">增加商品行</button><button class="btn primary" type="submit" ${activeSuppliers.length ? '' : 'disabled'}>确认到货并入库</button></div><p class="help">每个条码填写一行。按件商品填整数，按千克商品最多三位小数；进货单价按每件或每千克填写。</p></form></div></section>
    </div>
    <section class="card procurement-section"><div class="card-heading"><h2>供应商列表</h2><span class="pill">${data.suppliers.length} 家</span></div>${data.suppliers.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>联系人</th><th>电话</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.suppliers.map((supplier) => `<tr><td><strong>${esc(supplier.name)}</strong>${supplier.notes ? `<small>${esc(supplier.notes)}</small>` : ''}</td><td>${esc(supplier.contact_name) || '—'}</td><td>${esc(supplier.phone) || '—'}</td><td>${supplier.active ? '启用' : '停用'}</td><td><button class="link-button" type="button" data-edit-supplier="${esc(supplier.id)}">编辑</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">尚未录入供应商。先填写上方资料，再登记到货。</div>'}</section>
    <section class="card procurement-section"><div class="card-heading"><h2>最近到货记录</h2><span class="pill">最近 ${data.receipts.length} 张</span></div>${data.receipts.length ? `<div class="receipt-history">${data.receipts.map((receipt) => `<details><summary><span><strong>${esc(receipt.supplier_name)}</strong><small>${time(receipt.received_at)} · ${receipt.reference_no ? `单号 ${esc(receipt.reference_no)}` : '未填供货单号'} · ${esc(receipt.receiver_name)}</small></span><b>${money(receipt.total_cost_cents)}</b></summary><div class="table-wrap"><table><thead><tr><th>商品</th><th>数量</th><th>进货单价</th><th>小计</th></tr></thead><tbody>${receipt.items.map((item) => `<tr><td>${esc(item.name)}<small>${esc(item.barcode)}</small></td><td>${qtyText(item.quantity_milli, item.unit)}</td><td>${money(item.unit_cost_cents)}</td><td>${money(item.line_cost_cents)}</td></tr>`).join('')}</tbody></table></div>${receipt.note ? `<p class="receipt-note">备注：${esc(receipt.note)}</p>` : ''}</details>`).join('')}</div>` : '<div class="empty">暂无到货记录。</div>'}</section>`;
}

function renderTeam() {
  return `${header('账号与权限', '员工账号', '每位收银员使用独立账号；特殊操作需要店主审批。')}
    <div class="grid two"><div class="card"><div class="card-heading"><h2>新增收银员</h2></div><div class="card-body"><form id="user-form" class="stack"><div class="field"><label for="employee-name">姓名</label><input id="employee-name" name="displayName" required maxlength="50"></div><div class="field"><label for="employee-username">登录账号</label><input id="employee-username" name="username" required minlength="3" maxlength="32" autocapitalize="off"></div><div class="field"><label for="employee-password">初始密码</label><input id="employee-password" name="password" type="password" required minlength="10" autocomplete="new-password"></div><button class="btn primary" type="submit">创建收银员</button></form></div></div>
    <div class="card"><div class="card-heading"><h2>权限说明</h2></div><div class="card-body stack"><p><strong>收银员</strong>：开班、收银、交班、申请退款；不能改商品价格、导入流水或审批自己的操作。</p><p><strong>店主</strong>：管理商品与账号、审批、核对支付和处理异常。</p><div class="banner info"><strong>远程查看</strong>本地运行时仅本机可访问。要在外面用手机查看，需将服务部署到带 HTTPS 的服务器或通过安全 VPN 访问。</div></div></div></div>
    <div class="section-title"><h2>现有账号</h2></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${state.users.map((user) => `<tr><td><strong>${esc(user.display_name)}</strong></td><td>${esc(user.username)}</td><td>${user.role === 'owner' ? '店主' : '收银员'}</td><td>${user.active ? '启用' : '停用'}</td><td>${time(user.created_at)}</td><td>${user.role === 'cashier' ? `<div class="row"><button class="link-button" type="button" data-toggle-user="${esc(user.id)}">${user.active ? '停用' : '启用'}</button><button class="link-button" type="button" data-reset-user="${esc(user.id)}">重设密码</button></div>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderAudit() {
  return `${header('操作留痕', '操作记录', state.user.role === 'owner' ? '按时间查看全店关键业务操作。' : '按时间查看自己的关键业务操作。')}
    ${state.audit.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>${state.audit.map((entry) => `<tr><td>${time(entry.created_at)}</td><td>${esc(entry.actor_name || '系统')}</td><td><strong>${esc(entry.action)}</strong></td><td>${esc(entry.entity_type)} · ${shortId(entry.entity_id)}</td><td><small>${esc(entry.details)}</small></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无操作记录。</div>'}`;
}

function broadcastCart() {
  customerChannel.postMessage({
    type: 'cart', totalCents: state.cart.length && state.tab === 'pos' ? cartSubtotal() : 0,
    items: state.cart.length && state.tab === 'pos' ? state.cart.map((item) => ({ name: item.product.name, quantity: item.product.unit === 'kg' ? `${(item.quantityMilli / 1000).toFixed(3)} kg` : `${item.quantityMilli / 1000} 件`, unitPriceCents: item.unitPriceCents, lineCents: Math.round(item.unitPriceCents * item.quantityMilli / 1000) })) : [],
  });
}
customerChannel.onmessage = (event) => { if (event.data?.type === 'request') broadcastCart(); };
function render() {
  app.innerHTML = !state.initialized || !state.user ? renderAuth() : shell();
  syncDashboardRefresh();
  broadcastCart();
}

function syncDashboardRefresh() {
  const shouldRefresh = state.user?.role === 'owner' && state.tab === 'dashboard';
  if (shouldRefresh && !dashboardRefreshTimer) {
    dashboardRefreshTimer = setInterval(() => {
      if (!document.hidden) refreshDashboard();
    }, DASHBOARD_REFRESH_MS);
  } else if (!shouldRefresh && dashboardRefreshTimer) {
    clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
}

async function refreshDashboard() {
  if (state.user?.role !== 'owner' || state.tab !== 'dashboard' || state.dashboardRefreshing) return;
  state.dashboardRefreshing = true;
  state.dashboardRefreshError = null;
  render();
  try {
    const data = await api('/dashboard');
    if (state.user?.role === 'owner' && state.tab === 'dashboard') {
      state.dashboard = data;
      state.dashboardUpdatedAt = new Date();
    }
  } catch (error) {
    if (state.user?.role === 'owner' && state.tab === 'dashboard') state.dashboardRefreshError = error.message;
  } finally {
    state.dashboardRefreshing = false;
    if (state.user?.role === 'owner' && state.tab === 'dashboard') render();
  }
}

function addProduct(product) {
  const existing = state.cart.find((item) => item.product.id === product.id && item.unitPriceCents === product.price_cents);
  if (existing && product.unit === 'piece') existing.quantityMilli += 1000;
  else state.cart.push({ product, quantityMilli: 1000, unitPriceCents: product.price_cents });
  state.searchText = '';
  state.missingBarcode = null;
  state.searchResults = state.products;
  state.notice = product.unit === 'kg' ? { type: 'info', text: `${product.name} 已加入，请填写实际重量` } : null;
  render();
  if (product.unit === 'kg') document.querySelector(`[data-cart-qty="${state.cart.length - 1}"]`)?.focus();
  else document.querySelector('#product-search')?.focus();
}

async function findProductByBarcode(barcode, includeInactive = false) {
  if (includeInactive) return api(`/products/by-barcode?barcode=${encodeURIComponent(barcode)}`);
  const result = await api(`/products?q=${encodeURIComponent(barcode)}&limit=20`);
  return result.items.find((item) => item.barcode === barcode) || null;
}

function fillProductForm(product, barcode = '') {
  const form = document.querySelector('#product-form');
  if (!form) return;
  form.elements.productId.value = product?.id || '';
  form.elements.barcode.value = product?.barcode || barcode;
  form.elements.name.value = product?.name || '';
  form.elements.unit.value = product?.unit || 'piece';
  form.elements.price.value = product ? (product.price_cents / 100).toFixed(2) : '';
  form.elements.cost.value = product?.latest_cost_cents == null ? '' : (product.latest_cost_cents / 100).toFixed(2);
  form.elements.stock.value = product ? (product.stock_milli / 1000).toFixed(product.unit === 'kg' ? 3 : 0) : '0';
  form.elements.reason.value = '商品资料维护';
  const status = document.querySelector('#product-barcode-status');
  if (status) status.textContent = product ? '已找到本店商品，名称、单位和售价已带出。' : '新条码已录入，请填写商品名称和本店售价，或先导入商品表。';
  form.elements.name.focus();
}

async function handleScannedBarcode(rawBarcode, destination) {
  const barcode = String(rawBarcode || '').trim();
  if (!barcode || barcode.length > 64) throw new Error('条码为空或超过 64 个字符');
  const product = await findProductByBarcode(barcode, destination === 'catalog');
  if (destination === 'catalog') {
    if (state.user?.role !== 'owner') throw new Error('只有店主可以录入商品');
    if (state.tab !== 'products') { state.tab = 'products'; await loadTab(); render(); }
    fillProductForm(product, barcode);
    return;
  }
  if (state.tab !== 'pos') { state.tab = 'pos'; await loadTab(); render(); }
  if (product) addProduct(product);
  else {
    state.searchText = barcode;
    state.searchResults = [];
    state.missingBarcode = barcode;
    state.notice = { type: 'error', text: `条码 ${barcode} 尚未录入商品库，请店主先导入或新建商品` };
    render();
    document.querySelector('#product-search')?.focus();
  }
}

function stopCameraScan() {
  if (!cameraScan) return;
  cameraScan.stopped = true;
  clearTimeout(cameraScan.timer);
  cameraScan.controls?.stop();
  cameraScan.stream?.getTracks().forEach((track) => track.stop());
  cameraScan.overlay.remove();
  cameraScan = null;
}

function loadZxing() {
  if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
  if (!zxingLoad) zxingLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/zxing-browser.min.js';
    script.onload = () => window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(new Error('条码识别组件加载失败'));
    script.onerror = () => reject(new Error('条码识别组件加载失败'));
    document.head.append(script);
  }).catch((error) => { zxingLoad = null; throw error; });
  return zxingLoad;
}

async function startCameraScan(destination) {
  if (cameraScan) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    state.notice = { type: 'error', text: '当前页面无法访问摄像头。请用扫码枪或手动输入条码；手机摄像头需要 HTTPS 页面和浏览器授权。' };
    render();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'scan-overlay';
  overlay.innerHTML = `<div class="scan-dialog" role="dialog" aria-modal="true" aria-label="摄像头扫描商品条码"><div class="row between"><h2>扫描商品条码</h2><button class="btn text" type="button" data-close-camera>关闭</button></div><video autoplay muted playsinline aria-label="摄像头预览"></video><p class="small-muted">将商品条码放进画面。识别成功后会自动${destination === 'pos' ? '加入购物车' : '填写商品条码'}。</p></div>`;
  document.body.append(overlay);
  const scan = { overlay, stream: null, controls: null, timer: null, stopped: false };
  cameraScan = scan;
  overlay.querySelector('[data-close-camera]').focus();
  try {
    const video = overlay.querySelector('video');
    if (typeof window.BarcodeDetector !== 'function') {
      const zxing = await loadZxing();
      if (scan.stopped) return;
      const reader = new zxing.BrowserMultiFormatOneDReader();
      const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video, (result, error, activeControls) => {
        if (!result || scan.stopped) return;
        activeControls.stop();
        stopCameraScan();
        handleScannedBarcode(result.getText(), destination).catch((failure) => { state.notice = { type: 'error', text: failure.message }; render(); });
      });
      if (scan.stopped) controls.stop();
      else scan.controls = controls;
      return;
    }
    const supported = await window.BarcodeDetector.getSupportedFormats?.();
    const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
    const formats = supported?.filter((format) => wanted.includes(format));
    const detector = formats?.length ? new window.BarcodeDetector({ formats }) : new window.BarcodeDetector();
    scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (scan.stopped) { scan.stream.getTracks().forEach((track) => track.stop()); return; }
    video.srcObject = scan.stream;
    await video.play();
    const detect = async () => {
      if (scan.stopped) return;
      try {
        if (video.readyState >= 2) {
          const results = await detector.detect(video);
          const barcode = results.find((item) => item.rawValue?.trim());
          if (barcode) {
            stopCameraScan();
            await handleScannedBarcode(barcode.rawValue, destination);
            return;
          }
        }
      } catch (error) {
        stopCameraScan();
        state.notice = { type: 'error', text: `摄像头识别失败：${error.message}` };
        render();
        return;
      }
      if (!scan.stopped) scan.timer = setTimeout(detect, 180);
    };
    detect();
  } catch (error) {
    stopCameraScan();
    state.notice = { type: 'error', text: error.name === 'NotAllowedError' ? '摄像头权限未开启，请在浏览器中允许访问摄像头' : `无法启动摄像头：${error.message}` };
    render();
  }
}

function parseCsv(text) {
  const lines = [];
  let fields = [], field = '', quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      fields.push(field); field = '';
      if (fields.some((value) => value.trim())) lines.push(fields);
      fields = [];
    } else field += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  fields.push(field);
  if (fields.some((value) => value.trim())) lines.push(fields);
  if (lines.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  const headers = lines.shift().map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头有重复列');
  return lines.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数不正确`);
    return Object.fromEntries(headers.map((header, position) => [header, values[position].trim()]));
  });
}

function downloadTemplate(kind) {
  const content = kind === 'products'
    ? 'barcode,name,unit,price_yuan,cost_yuan,stock\n6900000000011,示例矿泉水,piece,2.50,1.20,30\n6900000000028,示例散装苹果,kg,8.90,5.40,15.500\n'
    : 'channel,transaction_id,order_id,amount_yuan,status,paid_at\nwechat,WX-DEMO-001,,12.50,SUCCESS,2026-10-12T10:00:00+08:00\n';
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = kind === 'products' ? '商品导入模板.csv' : '渠道流水导入模板.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function resolveReceiptBarcode(input) {
  const line = input.closest('[data-receipt-line]');
  if (!line) return false;
  const hint = line.querySelector('[data-receipt-match]');
  const barcode = input.value.trim();
  if (!barcode) { hint.textContent = '输入商品条码后显示名称与单位。'; return false; }
  try {
    const product = await api(`/products/by-barcode?barcode=${encodeURIComponent(barcode)}`);
    if (input.value.trim() !== barcode) return false;
    if (!product || !product.active) { hint.textContent = '该条码未建档或已停用，请先到“商品与库存”录入。'; return false; }
    hint.textContent = `${product.name} · ${product.unit === 'kg' ? '千克' : '件'} · 当前库存 ${qtyText(product.stock_milli, product.unit)}${product.latest_cost_cents == null ? '' : ` · 最近进货成本 ${money(product.latest_cost_cents)}`}`;
    const costInput = line.querySelector('[name="receiptCost"]');
    if (!costInput.value && product.latest_cost_cents != null) costInput.value = (product.latest_cost_cents / 100).toFixed(2);
    return true;
  } catch (error) { hint.textContent = error.message; return false; }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  if (target.dataset.dashboardMonth) {
    state.selectedMonth = target.dataset.dashboardMonth;
    document.querySelector('.dashboard-monthly').outerHTML = renderMonthlyOverview(state.dashboard);
    if (window.matchMedia('(max-width: 1100px)').matches) document.querySelector('.monthly-detail')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (target.dataset.loginRole) {
    state.loginRole = target.dataset.loginRole;
    document.querySelectorAll('[data-login-role]').forEach((button) => {
      const active = button.dataset.loginRole === state.loginRole;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelector('#login-form input[name="role"]').value = state.loginRole;
    document.querySelector('#login-form h2').textContent = `${state.loginRole === 'owner' ? '店主' : '员工'}登录`;
    return;
  }
  if (target.dataset.action === 'refresh-dashboard') { await refreshDashboard(); return; }
  if (target.dataset.editSupplier) {
    const supplier = state.procurement?.suppliers.find((item) => item.id === target.dataset.editSupplier);
    const form = document.querySelector('#supplier-form');
    if (!supplier || !form) return;
    form.elements.supplierId.value = supplier.id;
    form.elements.name.value = supplier.name;
    form.elements.contactName.value = supplier.contact_name;
    form.elements.phone.value = supplier.phone;
    form.elements.notes.value = supplier.notes;
    form.elements.active.value = supplier.active ? 'true' : 'false';
    form.scrollIntoView({ block: 'start' });
    form.elements.name.focus();
    return;
  }
  const nav = target.dataset.nav;
  if (nav) {
    if (!navigationTabs().some(([key]) => key === nav)) return;
    state.tab = nav;
    state.selectedOrder = null;
    state.notice = null;
    await run(() => loadTab(), '已切换页面');
    state.notice = null; render();
    document.querySelector('.nav button.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const productId = target.dataset.addProduct;
  if (productId) { const product = state.searchResults.find((item) => item.id === productId); if (product) addProduct(product); return; }
  if (target.dataset.cameraScan) { await startCameraScan(target.dataset.cameraScan); return; }
  if (target.dataset.closeCamera !== undefined) { stopCameraScan(); return; }
  if (target.dataset.newProductBarcode) {
    const barcode = target.dataset.newProductBarcode;
    state.pendingAddBarcode = barcode;
    state.tab = 'products';
    await run(() => loadTab(), '请填写商品名称和售价');
    fillProductForm(null, barcode);
    return;
  }
  if (target.dataset.rejectProductRequest) {
    const reason = prompt('请输入拒绝原因');
    if (reason === null) return;
    await run(async () => { await api(`/product-requests/${target.dataset.rejectProductRequest}/decision`, { method: 'POST', body: { approve: false, reason } }); await loadTab(); }, '建档申请已拒绝');
    return;
  }
  if (target.dataset.removeItem !== undefined) { state.cart.splice(Number(target.dataset.removeItem), 1); render(); return; }
  const orderId = target.dataset.openOrder;
  if (orderId) { state.tab = 'orders'; await run(async () => { await loadTab(); state.selectedOrder = await api(`/orders/${orderId}`); }, '订单已打开'); state.notice = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (target.dataset.drawerOpen) {
    const reason = prompt('请输入非销售开钱箱原因。本操作只登记记录，不会控制实体钱箱。');
    if (reason === null) return;
    await run(async () => { await api(`/shifts/${target.dataset.drawerOpen}/drawer-open`, { method: 'POST', body: { reason } }); }, '开钱箱记录已保存'); return;
  }
  if (target.dataset.digitalPending) { await run(async () => { state.selectedOrder = await api(`/orders/${target.dataset.digitalPending}/pay`, { method: 'POST', body: {} }); await loadTab(); }, '订单已登记为待核实付款'); return; }
  if (target.dataset.orderDecision) { await run(async () => { state.selectedOrder = await api(`/orders/${target.dataset.id}/decision`, { method: 'POST', body: { approve: target.dataset.orderDecision === 'approve' } }); await loadTab(); }, '审批已处理'); return; }
  if (target.dataset.orderVoid) {
    const reason = prompt('请输入取消原因。待核实付款订单取消前，应先确认渠道没有收款。');
    if (reason === null) return;
    await run(async () => { state.selectedOrder = await api(`/orders/${target.dataset.orderVoid}/void`, { method: 'POST', body: { reason } }); await loadTab(); }, '订单已取消'); return;
  }
  if (target.dataset.refundDecision) { await run(async () => { await api(`/refunds/${target.dataset.id}/decision`, { method: 'POST', body: { approve: target.dataset.refundDecision === 'approve' } }); await loadTab(); }, '退款审批已处理'); return; }
  if (target.dataset.exceptionResolve) {
    const resolution = prompt('请输入核实结果和处理说明');
    if (resolution === null) return;
    await run(async () => { await api(`/exceptions/${target.dataset.exceptionResolve}/resolve`, { method: 'POST', body: { resolution } }); await loadTab(); }, '异常已记录处理结论'); return;
  }
  if (target.dataset.linkStatement) {
    const orderId = prompt('请输入要匹配的完整订单号。系统会校验渠道、金额和订单状态。');
    if (orderId === null) return;
    await run(async () => { await api(`/statements/${target.dataset.linkStatement}/link`, { method: 'POST', body: { orderId: orderId.trim() } }); await loadTab(); }, '渠道流水已匹配订单'); return;
  }
  if (target.dataset.reviewApproval) {
    if (target.dataset.kind === 'PRICE') {
      state.tab = 'orders'; await run(async () => { await loadTab(); state.selectedOrder = await api(`/orders/${target.dataset.reviewApproval}`); }, '待审批订单已打开');
    } else {
      state.tab = 'orders'; await run(async () => { await loadTab(); state.selectedOrder = await api(`/orders/${target.dataset.orderId}`); }, '退款申请已打开');
    }
    return;
  }
  if (target.dataset.editProduct) {
    const product = state.products.find((item) => item.id === target.dataset.editProduct);
    if (product) { fillProductForm(product); document.querySelector('#product-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return;
  }
  if (target.dataset.adjustStock) {
    const product = state.products.find((item) => item.id === target.dataset.adjustStock);
    if (!product) return;
    const quantity = prompt(`${product.name}：输入库存增减数量（${product.unit === 'kg' ? '千克' : '件'}），例如 10 或 -2`);
    if (quantity === null) return;
    const reason = prompt('请输入库存调整原因');
    if (reason === null) return;
    await run(async () => { const deltaMilli = Math.round(Number(quantity) * 1000); if (!Number.isSafeInteger(deltaMilli) || !deltaMilli) throw new Error('调整数量无效'); await api(`/products/${product.id}/stock`, { method: 'POST', body: { deltaMilli, reason } }); await loadTab(); }, '库存已调整'); return;
  }
  if (target.dataset.countStock) {
    const product = state.products.find((item) => item.id === target.dataset.countStock);
    if (!product) return;
    const actual = prompt(`${product.name}：输入实盘数量（${product.unit === 'kg' ? '千克' : '件'}），系统当前账面为 ${qtyText(product.stock_milli, product.unit)}`);
    if (actual === null) return;
    const reason = prompt('请输入抽盘说明');
    if (reason === null) return;
    await run(async () => { const countedMilli = quantityFromInput(actual, product.unit, true); await api(`/products/${product.id}/count`, { method: 'POST', body: { countedMilli, reason } }); await loadTab(); }, '抽盘已记录，差异会显示在店主总览'); return;
  }
  if (target.dataset.downloadTemplate) { downloadTemplate(target.dataset.downloadTemplate); return; }
  if (target.dataset.toggleUser) {
    const cashier = state.users.find((item) => item.id === target.dataset.toggleUser);
    if (!cashier || !confirm(`${cashier.active ? '停用' : '启用'}收银员 ${cashier.display_name}？`)) return;
    await run(async () => { await api(`/users/${cashier.id}`, { method: 'PATCH', body: { active: !cashier.active } }); await loadTab(); }, '账号状态已更新'); return;
  }
  if (target.dataset.resetUser) {
    const cashier = state.users.find((item) => item.id === target.dataset.resetUser);
    if (!cashier) return;
    const password = prompt(`请输入 ${cashier.display_name} 的新密码（至少 10 位）。密码更新后其现有登录会失效。`);
    if (password === null) return;
    await run(async () => { await api(`/users/${cashier.id}`, { method: 'PATCH', body: { password } }); await loadTab(); }, '密码已重设'); return;
  }
  const action = target.dataset.action;
  if (action === 'add-receipt-line') { document.querySelector('#receipt-lines')?.insertAdjacentHTML('beforeend', receiptLineHtml()); return; }
  if (action === 'remove-receipt-line') {
    const lines = document.querySelectorAll('[data-receipt-line]');
    if (lines.length > 1) target.closest('[data-receipt-line]')?.remove();
    else {
      lines[0]?.querySelectorAll('input').forEach((input) => { input.value = ''; });
      const hint = lines[0]?.querySelector('[data-receipt-match]');
      if (hint) hint.textContent = '输入商品条码后显示名称与单位。';
    }
    return;
  }
  if (action === 'clear-supplier-form') { document.querySelector('#supplier-form')?.reset(); document.querySelector('#supplier-form [name="supplierId"]').value = ''; return; }
  if (action === 'dismiss-notice') { state.notice = null; render(); }
  if (action === 'logout') { await run(async () => { await api('/logout', { method: 'POST', body: {} }); state.user = null; state.shift = null; state.cart = []; state.tab = 'pos'; }, '已退出登录'); }
  if (action === 'clear-cart') { state.cart = []; render(); }
  if (action === 'close-order') { state.selectedOrder = null; render(); }
  if (action === 'refresh-orders') await run(() => loadTab(), '订单已刷新');
  if (action === 'clear-product-form') document.querySelector('#product-form')?.reset();
  if (action === 'print') window.print();
});

document.addEventListener('input', async (event) => {
  if (event.target.id === 'product-search') {
    state.searchText = event.target.value;
    if (state.missingBarcode !== state.searchText.trim()) state.missingBarcode = null;
    const current = state.searchText;
    clearTimeout(state.searchTimer);
    const serial = state.searchSerial = (state.searchSerial || 0) + 1;
    state.searchTimer = setTimeout(async () => {
      try {
        const result = await api(`/products?q=${encodeURIComponent(current)}&limit=60`);
        if (state.searchText !== current || state.searchSerial !== serial) return;
        const exact = current.length >= 6 && result.items.find((item) => item.barcode === current.trim());
        if (exact) { addProduct(exact); return; }
        state.searchResults = result.items;
        if (!result.items.length && /^[A-Za-z0-9._-]{8,64}$/.test(current.trim())) {
          state.missingBarcode = current.trim();
          render();
          document.querySelector('#product-search')?.focus();
          return;
        }
        const list = document.querySelector('#search-results');
        if (list) list.innerHTML = searchResultsHtml();
      } catch (error) { state.notice = { type: 'error', text: error.message }; render(); }
    }, 220);
  }
  if (event.target.id === 'product-barcode') {
    const current = event.target.value.trim();
    clearTimeout(state.catalogBarcodeTimer);
    if (current.length < 6) return;
    state.catalogBarcodeTimer = setTimeout(async () => {
      try {
        const product = await findProductByBarcode(current, true);
        const form = document.querySelector('#product-form');
        if (!form || form.elements.barcode.value.trim() !== current) return;
        if (product) fillProductForm(product);
        else if (form.elements.productId.value) fillProductForm(null, current);
        else {
          const status = document.querySelector('#product-barcode-status');
          if (status) status.textContent = '本店还没有这个条码。请填写名称和售价，或先导入商品表。';
          if (/^\d{8}$|^\d{12,14}$/.test(current)) form.elements.name.focus();
        }
      } catch (error) { state.notice = { type: 'error', text: error.message }; render(); }
    }, 300);
  }
  if (event.target.id === 'catalog-search') {
    state.productQuery = event.target.value;
    const current = state.productQuery;
    clearTimeout(state.catalogTimer);
    state.catalogTimer = setTimeout(async () => {
      try {
        const result = await api(`/products?q=${encodeURIComponent(current)}&limit=100`);
        if (current !== state.productQuery) return;
        state.products = result.items; state.productTotal = result.total;
        render(); document.querySelector('#catalog-search')?.focus();
      } catch (error) { state.notice = { type: 'error', text: error.message }; render(); }
    }, 220);
  }
});

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape' && cameraScan) { stopCameraScan(); return; }
  if (event.target.matches('[data-receipt-barcode]') && event.key === 'Enter') { event.preventDefault(); if (await resolveReceiptBarcode(event.target)) event.target.closest('[data-receipt-line]')?.querySelector('[name="receiptQuantity"]')?.focus(); return; }
  if (!['product-search', 'product-barcode'].includes(event.target.id) || event.key !== 'Enter') return;
  event.preventDefault();
  const query = event.target.value.trim();
  if (!query) return;
  clearTimeout(event.target.id === 'product-search' ? state.searchTimer : state.catalogBarcodeTimer);
  if (event.target.id === 'product-search') state.searchSerial = (state.searchSerial || 0) + 1;
  try {
    await handleScannedBarcode(query, event.target.id === 'product-search' ? 'pos' : 'catalog');
  } catch (error) { state.notice = { type: 'error', text: error.message }; render(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCameraScan();
  else if (state.user?.role === 'owner' && state.tab === 'dashboard') refreshDashboard();
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-receipt-barcode]')) { resolveReceiptBarcode(event.target); return; }
  const index = event.target.dataset.cartQty ?? event.target.dataset.cartPrice;
  if (index === undefined) return;
  try {
    const item = state.cart[Number(index)];
    if (!item) return;
    if (event.target.dataset.cartQty !== undefined) item.quantityMilli = quantityFromInput(event.target.value, item.product.unit);
    else item.unitPriceCents = centsFromYuan(event.target.value, '成交单价');
    render();
  } catch (error) { state.notice = { type: 'error', text: error.message }; render(); }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.id && !form.classList.contains('product-request-review')) return;
  event.preventDefault();
  const values = new FormData(form);
  if (form.id === 'setup-form') return run(async () => { await api('/setup', { method: 'POST', body: Object.fromEntries(values) }); state.initialized = true; }, '店主账号已创建，请登录');
  if (form.id === 'login-form') return run(async () => { state.user = await api('/login', { method: 'POST', body: Object.fromEntries(values) }); state.tab = 'pos'; await loadTab(); }, '登录成功');
  if (form.id === 'open-shift-form') return run(async () => { state.shift = await api('/shifts/open', { method: 'POST', body: { openingCashCents: centsFromYuan(values.get('openingCash'), '备用金') } }); await loadTab(); }, '班次已开始');
  if (form.id === 'close-shift-form') return run(async () => { await api(`/shifts/${state.shift.id}/close`, { method: 'POST', body: { countedCashCents: centsFromYuan(values.get('countedCash'), '实点现金'), note: values.get('note') } }); await loadTab(); }, '交班已完成，请查看现金差额');
  if (form.id === 'cash-event-form') return run(async () => { await api(`/shifts/${values.get('shiftId')}/cash-events`, { method: 'POST', body: { type: values.get('type'), amountCents: centsFromYuan(values.get('amount')), reason: values.get('reason') } }); await loadTab(); }, '现金变动已登记');
  if (form.id === 'checkout-form') return run(async () => {
    const order = await api('/orders', { method: 'POST', body: {
      items: state.cart.map((item) => ({ productId: item.product.id, quantityMilli: item.quantityMilli, unitPriceCents: item.unitPriceCents })),
      method: values.get('method'), discountCents: centsFromYuan(values.get('discount') || '0'), overrideReason: values.get('overrideReason'),
    } });
    state.cart = []; state.tab = 'orders'; await loadTab(); state.selectedOrder = order;
  }, '订单已创建，请继续处理收款');
  if (form.id === 'cash-pay-form') return run(async () => { state.selectedOrder = await api(`/orders/${values.get('orderId')}/pay`, { method: 'POST', body: { receivedCashCents: centsFromYuan(values.get('received'), '实收现金') } }); await loadTab(); }, '现金收款完成');
  if (form.id === 'product-request-form') return run(async () => { await api('/product-requests', { method: 'POST', body: { barcode: values.get('barcode'), name: values.get('name'), priceCents: centsFromYuan(values.get('price'), '建议售价') } }); state.missingBarcode = null; state.searchText = ''; await loadTab(); }, '建档申请已提交，店主批准后可重新扫描');
  if (form.classList.contains('product-request-review')) return run(async () => { await api(`/product-requests/${form.dataset.requestId}/decision`, { method: 'POST', body: { approve: true, name: values.get('name'), unit: values.get('unit'), priceCents: centsFromYuan(values.get('price'), '售价'), stockMilli: quantityFromInput(values.get('stock') || '0', values.get('unit'), true) } }); await loadTab(); }, '新商品已批准建档');
  if (form.id === 'payment-reference-form') return run(async () => { state.selectedOrder = await api(`/orders/${values.get('orderId')}/payment-reference`, { method: 'POST', body: { transactionId: values.get('transactionId') } }); await loadTab(); }, '交易号已登记，仍需渠道流水核实');
  if (form.id === 'refund-request-form') return run(async () => { await api(`/orders/${values.get('orderId')}/refund`, { method: 'POST', body: { reason: values.get('reason') } }); await loadTab(); }, '退款申请已提交');
  if (form.id === 'refund-complete-form') return run(async () => { state.selectedOrder = await api(`/refunds/${values.get('refundId')}/complete`, { method: 'POST', body: { reference: values.get('reference'), restock: values.get('restock') === 'on' } }); await loadTab(); }, '退款已记录完成');
  if (form.id === 'product-form') return run(async () => {
    const productId = values.get('productId');
    const body = { barcode: values.get('barcode'), name: values.get('name'), unit: values.get('unit'), priceCents: centsFromYuan(values.get('price'), '售价'), costCents: values.get('cost') ? centsFromYuan(values.get('cost'), '进货成本') : undefined, stockMilli: quantityFromInput(values.get('stock') || '0', values.get('unit'), true), reason: values.get('reason') };
    const saved = await api(productId ? `/products/${productId}` : '/products', { method: productId ? 'PATCH' : 'POST', body });
    if (state.pendingAddBarcode === saved.barcode) {
      state.pendingAddBarcode = null; state.missingBarcode = null; state.tab = 'pos'; await loadTab(); addProduct(saved);
    } else await loadTab();
  }, '商品已保存');
  if (form.id === 'supplier-form') return run(async () => {
    const supplierId = values.get('supplierId');
    await api(supplierId ? `/suppliers/${supplierId}` : '/suppliers', { method: supplierId ? 'PATCH' : 'POST', body: { name: values.get('name'), contactName: values.get('contactName'), phone: values.get('phone'), notes: values.get('notes'), active: values.get('active') === 'true' } });
    await loadTab();
  }, '供应商资料已保存');
  if (form.id === 'receipt-form') return run(async () => {
    const barcodes = values.getAll('receiptBarcode');
    const quantities = values.getAll('receiptQuantity');
    const costs = values.getAll('receiptCost');
    const items = barcodes.map((barcode, index) => ({ barcode, quantityMilli: quantityFromInput(quantities[index], 'kg'), unitCostCents: centsFromYuan(costs[index], '进货单价') }));
    const receipt = await api('/receipts', { method: 'POST', body: { supplierId: values.get('supplierId'), referenceNo: values.get('referenceNo'), note: values.get('note'), items } });
    await loadTab();
    state.notice = { type: 'success', text: `到货入库完成，${items.length} 种商品，合计 ${money(receipt.totalCostCents)}` };
  }, '到货入库完成');
  if (form.id === 'user-form') return run(async () => { await api('/users', { method: 'POST', body: Object.fromEntries(values) }); await loadTab(); }, '收银员账号已创建');
  if (form.id === 'product-import-form') return run(async () => {
    const file = values.get('file'); if (!file?.size) throw new Error('请选择 CSV 文件');
    const csv = parseCsv(await file.text());
    const rows = csv.map((item, index) => { try { return { barcode: item.barcode, name: item.name, unit: item.unit, priceCents: centsFromYuan(item.price_yuan, '售价'), costCents: item.cost_yuan ? centsFromYuan(item.cost_yuan, '进货成本') : undefined, stockMilli: quantityFromInput(item.stock || '0', item.unit, true) }; } catch (error) { throw new Error(`第 ${index + 2} 行：${error.message}`); } });
    const result = await api('/products/import', { method: 'POST', body: { rows } }); await loadTab(); state.notice = { type: 'success', text: `导入完成：新增 ${result.created}，更新 ${result.updated}` };
  }, '商品已导入');
  if (form.id === 'statement-import-form') return run(async () => {
    const file = values.get('file'); if (!file?.size) throw new Error('请选择 CSV 文件');
    const csv = parseCsv(await file.text());
    const rows = csv.map((item, index) => { try { return { channel: item.channel, transactionId: item.transaction_id, orderId: item.order_id, amountCents: centsFromYuan(item.amount_yuan), status: item.status, paidAt: item.paid_at }; } catch (error) { throw new Error(`第 ${index + 2} 行：${error.message}`); } });
    const result = await api('/statements/import', { method: 'POST', body: { rows } }); await loadTab(); state.notice = { type: 'success', text: `对账完成：匹配 ${result.matched}，未匹配 ${result.unmatched}，重复 ${result.duplicate}` };
  }, '渠道流水已导入');
});

bootstrap();

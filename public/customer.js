const channel = new BroadcastChannel('supermarket-pos-cart');
const items = document.querySelector('#customer-items');
const total = document.querySelector('#customer-total');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
channel.onmessage = (event) => {
  if (event.data?.type !== 'cart' || !Array.isArray(event.data.items)) return;
  items.innerHTML = event.data.items.length
    ? event.data.items.map((item) => `<div class="customer-item"><div><strong>${esc(item.name)}</strong><small>${esc(item.quantity)} × ${money(item.unitPriceCents)}</small></div><b>${money(item.lineCents)}</b></div>`).join('')
    : '<div class="empty">等待收银员扫描商品。</div>';
  total.textContent = money(event.data.totalCents);
};
channel.postMessage({ type: 'request' });

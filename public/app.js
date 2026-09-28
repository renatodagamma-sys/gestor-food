const brl = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
const pct = value => `${value.toFixed(1).replace('.',',')}%`;
const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusClass = status => status === 'ATENÇÃO' ? 'warn' : status === 'RECUPERAÇÃO' ? 'recover' : '';
const fetchJson = async (url) => {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Falha HTTP ${response.status}`);
  return body;
};
const showLoadError = () => {
  const status = document.querySelector('#system-status');
  if (status) status.textContent = 'Não foi possível carregar os dados agora. Tente novamente.';
};
window.addEventListener('error', showLoadError);
window.addEventListener('unhandledrejection', showLoadError);

const allowedScenarios = new Set(['normal', 'weak-sales', 'critical-reviews', 'cancellations']);
const requestedScenario = new URLSearchParams(location.search).get('scenario');
const currentScenario = allowedScenarios.has(requestedScenario) ? requestedScenario : 'normal';
document.querySelector('#scenario').value = currentScenario;
document.querySelector('#scenario').addEventListener('change', event => { location.search = `scenario=${encodeURIComponent(event.target.value)}`; });
const data = await fetchJson(`/api/demo?scenario=${encodeURIComponent(currentScenario)}`);
const integration = await fetchJson('/api/ifood/config');
const system = await fetchJson('/api/system/status');
const readiness = await fetchJson('/api/launch/readiness');
const scenarioQuery = `?scenario=${encodeURIComponent(currentScenario)}`;
document.querySelector('#products-report').href = `/api/reports/products.csv${scenarioQuery}`;
document.querySelector('#daily-report').href = `/api/reports/daily${scenarioQuery}`;
const goals = await fetchJson(`/api/goals${scenarioQuery}`);
const recovery = await fetchJson(`/api/recovery/store-2${scenarioQuery}`);
document.querySelector('#mode').textContent = integration.mode === 'REAL' ? 'INTEGRAÇÃO REAL' : 'MODO DEMO';
document.querySelector('#cost-lock').textContent = integration.enabled ? '⚠️ Integração real habilitada' : '🔒 Custos externos bloqueados';
const enabledModules = Object.values(system.modules).filter(Boolean).length;
const totalModules = Object.keys(system.modules).length;
const persistenceLabel = system.persistence?.productionReady ? 'persistência ativa' : 'persistência DEMO em memória';
document.querySelector('#system-status').textContent = `${enabledModules}/${totalModules} módulos ativos · ${persistenceLabel} · ${system.authRequired ? 'autenticação obrigatória' : 'autenticação opcional'}`;
document.querySelector('#readiness-summary').textContent = `${readiness.completed}/${readiness.total} itens concluídos · ${readiness.percent}%`;
document.querySelector('#readiness').innerHTML = readiness.checks.map(item => `<div class="item"><div class="item-title">${item.ready ? '✅' : '⬜'} ${esc(item.label)}</div><p>${esc(item.detail)}</p></div>`).join('');
const consolidated = data.consolidated;
document.querySelector('#finance-area').innerHTML = [
  ['Todas as lojas', brl(consolidated.grossCents)],
  ['Pedidos hoje', consolidated.orders],
  ['Resultado sem CMV', brl(consolidated.resultWithoutCmvCents)],
  ['% líquido', pct(consolidated.netPercent)]
].map(([label,value]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

document.querySelector('#stores-grid').innerHTML = data.stores.map(store => `<article class="store">
  <div class="store-head"><span class="store-name">${esc(store.name)}</span><span class="status ${statusClass(store.status)}">${esc(store.status)}</span></div>
  <div class="health"><div class="health-score">${store.health}<span class="health-label">/100<br>saúde</span></div><div style="flex:1"><div class="muted">Índice operacional</div><div class="bar"><i style="width:${store.health}%"></i></div></div></div>
  <div class="metrics"><div class="metric"><small>Faturamento</small><strong>${brl(store.metrics.grossCents)}</strong></div><div class="metric"><small>Pedidos</small><strong>${store.metrics.orders}</strong></div><div class="metric"><small>Resultado sem CMV</small><strong>${brl(store.resultCents)}</strong></div><div class="metric"><small>Ticket médio</small><strong>${brl(store.averageTicketCents)}</strong></div><div class="metric"><small>Avaliação</small><strong>★ ${store.reviews.toFixed(1).replace('.',',')}</strong></div><div class="metric"><small>Cancelamentos</small><strong>${pct(store.cancellationRate)}</strong></div></div>
</article>`).join('');
const recentOrders = data.stores.flatMap(store => store.orders.map(order => ({ ...order, storeName: store.name }))).slice(-10).reverse();
document.querySelector('#orders').innerHTML = recentOrders.map(order => { const cancelled = order.status === 'CANCELLED' || order.status === 'REFUNDED'; const result = cancelled ? 0 : order.grossCents - order.storeDiscountCents - order.commissionCents - order.paymentFeeCents - order.storePromotionCents - order.storeDeliveryCents - order.otherCostsCents; const gross = cancelled ? 0 : order.grossCents; return `<tr><td>${esc(order.id)}</td><td>${esc(order.storeName)}</td><td>${esc(order.createdAt.slice(11,16))}</td><td>${esc(order.status)}</td><td>${brl(gross)}</td><td>${brl(result)}</td></tr>`; }).join('');

document.querySelector('#opportunities').innerHTML = data.opportunities.map(item => `<div class="item"><div class="item-title">${esc(item.title)}</div><p>${esc(item.description)}</p><div class="impact">${esc(item.impact)}</div></div>`).join('');
document.querySelector('#approvals').innerHTML = data.approvals.map(item => `<div class="item approval" data-approval="${esc(item.id)}"><div><div class="item-title">${esc(item.title)}</div><p>Risco ${esc(item.risk)} · Custo máximo ${esc(item.cost)}</p><div class="impact">${esc(item.action)}</div></div><div class="approval-actions"><button class="btn approve" data-id="${esc(item.id)}">Autorizar</button><button class="btn secondary reject" data-id="${esc(item.id)}">Recusar</button></div></div>`).join('');
document.querySelector('#decisions').innerHTML = data.decisions.map(item => `<div class="timeline"><time>${esc(item.time)}</time><span class="store-label">${esc(item.store)}</span><span>${esc(item.event)}</span></div>`).join('');
document.querySelector('#forecasts').innerHTML = data.forecasts.map(item => `<div class="forecast"><div class="item-title">${esc(item.storeName)} · ${brl(item.expectedClosingCents)}</div><p>${esc(item.explanation)}</p><span class="confidence">${esc(item.confidence)} CONFIANÇA</span></div>`).join('');
document.querySelector('#alerts').innerHTML = data.alerts.map(item => `<div class="alert ${esc(item.level)}"><div class="alert-title">${esc(item.title)}</div><p>${esc(item.body)}</p></div>`).join('');
document.querySelector('#goals').innerHTML = goals.map(item => `<div class="forecast"><div class="item-title">${esc(item.storeName)} · meta ${brl(item.goalCents)}</div><p>Realizado: ${brl(item.realizedCents)} · Projeção: ${brl(item.forecastCents)}</p><span class="confidence">${item.forecastAtRisk ? `RECUPERAR ${brl(item.amountToRecoverCents)}` : 'META COBERTA'}</span></div>`).join('');
document.querySelector('#recovery').innerHTML = `<div class="item-title">${esc(recovery.recommendedStrategy)}</div><p>${esc(recovery.reason)}</p><p>Pedidos adicionais estimados: <strong>${recovery.additionalOrdersEstimate}</strong></p><span class="confidence">${esc(recovery.confidence)} CONFIANÇA · GAP ${brl(recovery.gapCents)}</span>`;
document.querySelector('#products').innerHTML = data.products.map(item => `<tr><td><strong>${esc(item.name)}</strong><br><span class="muted">${esc(item.category)}</span></td><td>${item.quantity}</td><td>${brl(item.grossCents)}</td><td><strong>${brl(item.resultCents)}</strong></td><td>${esc(item.classification)}</td></tr>`).join('');
document.querySelector('#reviews').innerHTML = data.reviews.map(item => `<div class="review"><div><span class="stars">${'★'.repeat(item.rating)}${'☆'.repeat(5-item.rating)}</span> · ${esc(item.category)}</div><p>“${esc(item.comment)}”</p><div class="suggestion">Resposta sugerida: ${esc(item.suggestedReply)}</div></div>`).join('');
document.querySelector('#updated').textContent = `26/09/2026 · ${data.mode}`;
document.querySelectorAll('.approval-actions button').forEach(button => button.addEventListener('click', async () => {
  const status = button.classList.contains('approve') ? 'APPROVED' : 'REJECTED';
  const response = await fetch(`/api/approvals/${encodeURIComponent(button.dataset.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, actor: 'admin-demo', note: 'Decisão registrada pela interface DEMO.' }) });
  const result = await response.json();
  const row = document.querySelector(`[data-approval="${CSS.escape(button.dataset.id)}"]`);
  if (response.ok) row.innerHTML = `<div><div class="item-title">${esc(result.title)}</div><p>Decisão registrada: ${esc(result.status)}</p></div>`;
  else button.textContent = result.error ?? 'Erro';
}));

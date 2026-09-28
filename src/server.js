import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoSnapshot, DEMO_SCENARIOS } from './domain/demo.js';
import { configureAuditPersistence, hydrateAudit, listAudit, recordAudit } from './domain/audit.js';
import { createIfoodClient, IfoodApiClient } from './integrations/ifood/client.js';
import { IfoodSyncService, MemoryEventRepository, MemoryOrderRepository } from './integrations/ifood/sync-service.js';
import { productsToCsv, ordersToCsv, dailyExecutiveSummary } from './domain/reports.js';
import { ApprovalInbox } from './domain/approvals.js';
import { validateEnvironment } from './security/config.js';
import { AuthService } from './security/auth.js';
import { redactSecrets } from './security/config.js';
import { aggregateDailyMetrics, aggregateHourlyMetrics } from './domain/metrics.js';
import { analyzeCatalog } from './domain/catalog.js';
import { classifyReview } from './domain/customer-insights.js';
import { calculateStoreHealth } from './domain/analytics.js';
import { buildRecoveryPlan } from './domain/analytics.js';
import { buildGoals } from './domain/goals.js';
import { aggregateOrders } from './domain/finance.js';
import { monitorMerchants } from './integrations/ifood/merchant-monitor.js';
import { requestId, logEntry, safeError } from './security/logger.js';
import { openapi } from './api/openapi.js';
import { criticalReviews } from './domain/review-service.js';
import { featureStatus } from './config/features.js';
import { SlidingWindowLimiter } from './security/config.js';
import { can } from './security/access.js';
import { Persistence } from './db/persistence.js';
import { PostgresApprovalRepository, PostgresEventRepository } from './db/operational-repositories.js';
import { buildLaunchReadiness } from './domain/readiness.js';

const root = fileURLToPath(new URL('../public', import.meta.url));
const persistence = new Persistence();
const snapshot = buildDemoSnapshot();
const ifoodClient = createIfoodClient();
const eventRepository = persistence.mode === 'POSTGRES' ? new PostgresEventRepository({ persistence }) : new MemoryEventRepository();
const ifoodSync = new IfoodSyncService({ client: ifoodClient, eventRepository, orderRepository: new MemoryOrderRepository() });
const approvalRepository = persistence.mode === 'POSTGRES' ? new PostgresApprovalRepository({ persistence }) : null;
const approvalInbox = new ApprovalInbox({ audit: recordAudit, persistence: approvalRepository });
const auth = new AuthService();
const limiter = new SlidingWindowLimiter({ limit: 120, windowMs: 60000 });
const authLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 60000 });
if (persistence.mode === 'POSTGRES') configureAuditPersistence({
  append: async entry => persistence.query(
    `INSERT INTO audit_logs (id, actor, action, entity, entity_id, metadata_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.actor, entry.action, entry.entity, entry.entityId ?? null, JSON.stringify(entry.metadata ?? {}), entry.createdAt]
  ),
  load: async () => {
    const result = await persistence.query('SELECT id, actor, action, entity, entity_id, metadata_json, created_at FROM audit_logs ORDER BY created_at ASC');
    return result.rows.map(row => ({ id: row.id, actor: row.actor, action: row.action, entity: row.entity, entityId: row.entity_id, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at }));
  }
});
for (const approval of snapshot.approvals) approvalInbox.create({ ...approval, companyId: snapshot.company.id });
recordAudit({ action: 'DEMO_SNAPSHOT_CREATED', actor: 'system', entity: 'demo', entityId: snapshot.company.id });
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export const server = http.createServer(async (req, res) => {
  const id = requestId();
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  const rateKey = process.env.TRUST_PROXY === 'true'
    ? (req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'local')
    : (req.socket.remoteAddress ?? 'local');
  if (req.url.startsWith('/api/') && !limiter.allow(String(rateKey))) { res.setHeader('Retry-After', '60'); return json(res, { error: 'Limite de requisições excedido.', requestId: id }, 429); }
  if (req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(new URL(req.url, 'http://localhost').pathname) && !authLimiter.allow(String(rateKey))) { res.setHeader('Retry-After', '60'); return json(res, { error: 'Limite de autenticação excedido.', requestId: id }, 429); }
  try {
    if (req.method === 'GET' && req.url === '/healthz') return json(res, { status: 'ok', mode: ifoodClient.enabled ? 'REAL' : 'DEMO' });
    if (req.method === 'GET' && req.url === '/readyz') { const environment = validateEnvironment(); const database = await persistence.check(); const valid = environment.valid && database.ready; const body = { status: valid ? 'ready' : 'not_ready', mode: ifoodClient.enabled ? 'REAL' : 'DEMO', errors: [...environment.errors, ...database.errors] }; if (persistence.mode === 'POSTGRES') body.persistence = database.mode; return json(res, body, valid ? 200 : 503); }
    if (req.url.startsWith('/api/') && process.env.REQUIRE_AUTH === 'true' && !isPublicApi(req.url) && !requireProtectedAuth(req)) return json(res, { error: 'Autenticação obrigatória.', requestId: id }, 401);
    const allowedMethods = allowedMethodsFor(req.url);
    if (allowedMethods && !allowedMethods.includes(req.method)) {
      res.setHeader('Allow', allowedMethods.join(', '));
      return json(res, { error: 'Método HTTP não permitido.', allowedMethods, requestId: id }, 405);
    }
    if (req.method === 'POST' && req.url === '/api/ifood/webhook') return await handleWebhook(req, res, id);
    if (req.method === 'POST' && req.url === '/api/auth/register') {
      if (ifoodClient.enabled && process.env.REQUIRE_AUTH !== 'true') return json(res, { error: 'Cadastro público desativado no modo REAL.' }, 403);
      return await handleAuthRegister(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/auth/login') return await handleAuthLogin(req, res);
    if (req.method === 'POST' && req.url === '/api/auth/logout') return await handleAuthLogout(req, res);
    if (req.method === 'GET' && req.url === '/api/auth/me') return await handleAuthMe(req, res);
    if (req.method === 'GET' && req.url === '/api/ifood/config') return json(res, { enabled: ifoodClient.enabled, configured: Boolean(ifoodClient.clientId && ifoodClient.clientSecret), mode: ifoodClient.enabled ? 'REAL' : 'DEMO' });
    if (req.method === 'GET' && req.url === '/api/ifood/health') return json(res, integrationHealth());
    if (req.method === 'GET' && req.url === '/api/ifood/merchants') return await handleIfoodRead(res, () => ifoodClient.listMerchants());
    if (req.url.startsWith('/api/ifood/orders/')) {
      const parts = req.url.split('/').slice(4).map(part => decodeURIComponent(part.split('?')[0]));
      const [orderId, operation] = parts;
      if (!orderId) return json(res, { error: 'orderId obrigatório.' }, 400);
      if (req.method === 'GET' && !operation) return await handleIfoodRead(res, () => ifoodClient.getOrder(orderId));
      if (req.method === 'GET' && operation === 'cancellationReasons') return await handleIfoodRead(res, () => ifoodClient.getCancellationReasons(orderId));
      const actions = { confirm: () => ifoodClient.confirmOrder(orderId), startPreparation: () => ifoodClient.startPreparation(orderId), readyToPickup: () => ifoodClient.readyToPickup(orderId), dispatch: () => ifoodClient.dispatchOrder(orderId), requestCancellation: async () => ifoodClient.requestCancellation(orderId, await readJson(req)) };
      if (req.method === 'POST' && actions[operation]) {
        if (!requireProtectedAuth(req) || !hasPermission(req, 'execute_actions')) return json(res, { error: 'Permissão insuficiente.' }, 403);
        try { return json(res, await actions[operation](), 202); } catch (error) { return json(res, { error: error.message }, 502); }
      }
    }
    if (req.url.startsWith('/api/ifood/merchants/')) {
      const parts = req.url.split('/').slice(4).map(part => decodeURIComponent(part.split('?')[0]));
      const [merchantId, operation, operationId] = parts;
      if (!merchantId) return json(res, { error: 'merchantId obrigatório.' }, 400);
      if (req.method === 'GET' && !operation) return await handleIfoodRead(res, () => ifoodClient.getMerchant(merchantId));
      if (req.method === 'GET' && operation === 'status') return await handleIfoodRead(res, () => ifoodClient.getMerchantStatus(merchantId));
      if (req.method === 'GET' && operation === 'interruptions') return await handleIfoodRead(res, () => ifoodClient.getMerchantInterruptions(merchantId));
      if (req.method === 'GET' && operation === 'opening-hours') return await handleIfoodRead(res, () => ifoodClient.getOpeningHours(merchantId));
      if (operation === 'interruptions' && req.method === 'POST' && !operationId) {
        if (!requireProtectedAuth(req) || !hasPermission(req, 'execute_actions')) return json(res, { error: 'Permissão insuficiente.' }, 403);
        try { return json(res, await ifoodClient.createMerchantInterruption(merchantId, await readJson(req)), 201); } catch (error) { return json(res, { error: error.message }, 502); }
      }
      if (operation === 'interruptions' && req.method === 'DELETE' && operationId) {
        if (!requireProtectedAuth(req) || !hasPermission(req, 'execute_actions')) return json(res, { error: 'Permissão insuficiente.' }, 403);
        try { await ifoodClient.deleteMerchantInterruption(merchantId, operationId); return json(res, { deleted: true }); } catch (error) { return json(res, { error: error.message }, 502); }
      }
    }
    if (req.method === 'GET' && req.url === '/api/ifood/merchants/status') {
      if (!ifoodClient.enabled) return json(res, { mode: 'DEMO', enabled: false, message: 'Monitoramento real desativado.' }, 409);
      const environment = validateEnvironment();
      if (!environment.valid) return json(res, { mode: 'REAL', enabled: true, status: 'CONFIG_ERROR', errors: environment.errors }, 503);
      return json(res, await monitorMerchants(ifoodClient));
    }
    if (req.method === 'POST' && req.url === '/api/ifood/sync') { if (!requireProtectedAuth(req)) return json(res, { error: 'Autenticação obrigatória.' }, 401); if (!hasPermission(req, 'execute_actions')) return json(res, { error: 'Permissão insuficiente.' }, 403); return await handleSync(req, res); }
    if (req.method === 'GET' && req.url === '/api/ifood/orders') return json(res, ifoodSync.orders.list());
    if (req.method === 'GET' && req.url === '/api/ifood/events') return json(res, ifoodSync.events.list());
    if (req.method === 'GET' && req.url === '/api/ifood/reconciliation') return json(res, ifoodSync.reconcile());
    if (req.method === 'POST' && req.url.startsWith('/api/approvals/')) {
      if (!requireProtectedAuth(req)) return json(res, { error: 'Autenticação obrigatória.' }, 401);
      if (!hasPermission(req, 'approve_actions')) return json(res, { error: 'Permissão insuficiente.' }, 403);
      const approvalId = req.url.split('/')[3]?.split('?')[0];
      const approval = approvalInbox.get(approvalId);
      if (approval?.storeId && !visibleStores(snapshot.stores, getRequestUser(req)).some(store => store.id === approval.storeId)) return json(res, { error: 'Acesso negado: loja não autorizada.' }, 403);
      return await handleApprovalDecision(req, res);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/reports/daily')) return json(res, dailyExecutiveSummary(scopedDemoSnapshot(req.url, req)));
    if (req.method === 'GET' && req.url.startsWith('/api/reports/products.csv')) { const reportSnapshot = scopedDemoSnapshot(req.url, req); return csv(res, productsToCsv(reportSnapshot.products), 'relatorio-produtos.csv'); }
    if (req.method === 'GET' && req.url.startsWith('/api/reports/orders.csv')) { const reportSnapshot = scopedDemoSnapshot(req.url, req); return csv(res, ordersToCsv(reportSnapshot.stores.flatMap(store => store.orders)), 'relatorio-pedidos.csv'); }
    if (req.method === 'GET' && req.url === '/api/backup/demo.json') { if (process.env.REQUIRE_AUTH === 'true' && !hasPermission(req, 'manage_settings')) return json(res, { error: 'Permissão insuficiente.' }, 403); return attachment(res, JSON.stringify({ exportedAt: new Date().toISOString(), mode: snapshot.mode, snapshot: redactSecrets(snapshot), audit: redactSecrets(listAudit()) }, (_, value) => typeof value === 'bigint' ? Number(value) : value, 2)); }
    if (req.url === '/api/demo/scenarios') return json(res, { scenarios: DEMO_SCENARIOS });
    if (req.url === '/api/demo' || req.url.startsWith('/api/demo?')) { const demoUrl = new URL(req.url, 'http://localhost'); return json(res, buildDemoSnapshot({ scenario: demoUrl.searchParams.get('scenario') ?? 'normal' })); }
    if (req.url === '/api/openapi.json') return json(res, openapi);
    if (req.url === '/api/system/status') return json(res, featureStatus(process.env, { mode: persistence.mode, productionReady: persistence.mode === 'POSTGRES' }));
    if (req.method === 'GET' && req.url === '/api/launch/readiness') {
      const integration = { enabled: ifoodClient.enabled, mode: ifoodClient.enabled ? 'REAL' : 'DEMO' };
      const system = featureStatus(process.env, { mode: persistence.mode, productionReady: persistence.mode === 'POSTGRES' });
      return json(res, buildLaunchReadiness({ integration, system, persistenceMode: persistence.mode }));
    }
    if (req.url === '/api/stores') return json(res, visibleStores(snapshot.stores, getRequestUser(req)).map(({ orders, ...store }) => store));
    if (req.url.startsWith('/api/stores/') && req.url.endsWith('/health')) {
      const storeId = req.url.split('/')[3];
      const store = visibleStores(snapshot.stores, getRequestUser(req)).find(item => item.id === storeId);
      if (!store) return json(res, { error: 'Loja não encontrada.', requestId: id }, 404);
      return json(res, calculateStoreHealth({ salesVariancePercent: Number((store.metrics.grossCents - BigInt(store.expectedCents)) * 100n / BigInt(store.expectedCents)), ticketVariancePercent: 0, cancellationRate: store.cancellationRate, reviewScore: store.reviews }));
    }
    if (req.url.startsWith('/api/recovery/')) {
      const requestSnapshot = demoSnapshotFor(req.url);
      const storeId = req.url.split('/')[3]?.split('?')[0];
      const store = visibleStores(requestSnapshot.stores, getRequestUser(req)).find(item => item.id === storeId);
      if (!store) return json(res, { error: 'Loja não encontrada.', requestId: id }, 404);
      const forecast = requestSnapshot.forecasts.find(item => item.storeId === storeId);
      return json(res, buildRecoveryPlan({ storeId, forecastCents: BigInt(forecast?.expectedClosingCents ?? store.expectedCents), goalCents: BigInt(store.goalCents), topProducts: requestSnapshot.products.filter(product => product.storeId === storeId).map(product => ({ averageTicketCents: BigInt(Math.round(product.grossCents / Math.max(product.quantity, 1))) })) }));
    }
    if (req.url.startsWith('/api/orders')) {
      const url = new URL(req.url, 'http://localhost');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const orders = visibleStores(snapshot.stores, getRequestUser(req)).flatMap(store => store.orders).filter(order => (!url.searchParams.get('storeId') || order.storeId === url.searchParams.get('storeId')) && (!url.searchParams.get('status') || order.status === url.searchParams.get('status')) && (!from || order.createdAt >= from) && (!to || order.createdAt <= to));
      if (url.pathname === '/api/orders') return json(res, orders);
    }
    if (req.url.startsWith('/api/orders/')) {
      const orderId = decodeURIComponent(req.url.split('/')[3]?.split('?')[0] ?? '');
      const order = visibleStores(snapshot.stores, getRequestUser(req)).flatMap(store => store.orders).find(item => item.id === orderId);
      return order ? json(res, order) : json(res, { error: 'Pedido não encontrado.', requestId: id }, 404);
    }
    if (req.url.startsWith('/api/finance/summary')) {
      const url = new URL(req.url, 'http://localhost');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const selected = visibleStores(snapshot.stores, getRequestUser(req)).flatMap(store => store.orders).filter(order => (!url.searchParams.get('storeId') || order.storeId === url.searchParams.get('storeId')) && (!from || order.createdAt >= from) && (!to || order.createdAt <= to));
      const totals = aggregateOrders(selected);
      return json(res, { scope: url.searchParams.get('storeId') ?? 'ALL_STORES', ...totals });
    }
    if (req.url === '/api/metrics') { const stores = visibleStores(snapshot.stores, getRequestUser(req)); return json(res, { consolidated: aggregateOrders(stores.flatMap(store => store.orders)), stores: stores.map(store => ({ id: store.id, name: store.name, metrics: store.metrics, health: store.health })) }); }
    if (req.url === '/api/metrics/daily') return json(res, aggregateDailyMetrics(visibleStores(snapshot.stores, getRequestUser(req)).flatMap(store => store.orders)));
    if (req.url === '/api/metrics/hourly') return json(res, aggregateHourlyMetrics(visibleStores(snapshot.stores, getRequestUser(req)).flatMap(store => store.orders)));
    if (req.url === '/api/forecasts') return json(res, snapshot.forecasts);
    if (req.url.startsWith('/api/goals')) {
      const requestSnapshot = demoSnapshotFor(req.url);
      const stores = visibleStores(requestSnapshot.stores, getRequestUser(req));
      const storeIds = new Set(stores.map(store => store.id));
      return json(res, buildGoals(stores, requestSnapshot.forecasts.filter(forecast => storeIds.has(forecast.storeId))));
    }
    const visibleStoreIds = new Set(visibleStores(snapshot.stores, getRequestUser(req)).map(store => store.id));
    if (req.url === '/api/catalog/analysis') return json(res, analyzeCatalog(snapshot.products.filter(product => visibleStoreIds.has(product.storeId)).map(product => ({ ...product, resultCents: BigInt(product.resultCents) }))));
    if (req.url === '/api/products') return json(res, snapshot.products.filter(product => visibleStoreIds.has(product.storeId)));
    if (req.url === '/api/reviews/analysis') return json(res, snapshot.reviews.filter(review => visibleStoreIds.has(review.storeId)).map(review => ({ ...review, category: classifyReview(review.comment), suggestedReply: review.suggestedReply }))); 
    if (req.url === '/api/reviews/critical') return json(res, criticalReviews(snapshot.reviews.filter(review => visibleStoreIds.has(review.storeId))));
    if (req.url === '/api/reviews') return json(res, snapshot.reviews.filter(review => visibleStoreIds.has(review.storeId)));
    if (req.url === '/api/alerts') return json(res, snapshot.alerts.filter(alert => !alert.storeId || visibleStoreIds.has(alert.storeId)));
    if (req.url === '/api/opportunities') return json(res, snapshot.opportunities.filter(opportunity => !opportunity.storeId || visibleStoreIds.has(opportunity.storeId)));
    if (req.url === '/api/approvals') return json(res, approvalInbox.list().filter(approval => !approval.storeId || visibleStoreIds.has(approval.storeId)));
    if (req.url === '/api/decisions') return json(res, snapshot.decisions);
    if (req.url === '/api/audit') { if (process.env.REQUIRE_AUTH === 'true' && !hasPermission(req, 'manage_settings')) return json(res, { error: 'Permissão insuficiente.' }, 403); return json(res, listAudit()); }
    if (req.url.startsWith('/api/')) return json(res, { error: 'Rota API não encontrada.', requestId: id }, 404);
    const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = normalize(join(root, requestPath));
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return send(res, 403, 'Forbidden');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !error?.statusCode) console.error(JSON.stringify(logEntry({ level: 'error', message: 'request_failed', requestId: id, metadata: safeError(error) })));
    send(res, error?.statusCode ?? 404, error?.statusCode === 413 ? 'Payload muito grande' : 'Not found');
  }
});

function demoSnapshotFor(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  return buildDemoSnapshot({ scenario: url.searchParams.get('scenario') ?? 'normal' });
}

function scopedDemoSnapshot(requestUrl, req) {
  const base = demoSnapshotFor(requestUrl);
  const stores = visibleStores(base.stores, getRequestUser(req));
  const storeIds = new Set(stores.map(store => store.id));
  return { ...base, stores, consolidated: aggregateOrders(stores.flatMap(store => store.orders)), forecasts: base.forecasts.filter(forecast => storeIds.has(forecast.storeId)), products: base.products.filter(product => storeIds.has(product.storeId)), reviews: base.reviews.filter(review => storeIds.has(review.storeId)), alerts: base.alerts.filter(alert => !alert.storeId || storeIds.has(alert.storeId)), opportunities: base.opportunities.filter(item => !item.storeId || storeIds.has(item.storeId)), approvals: base.approvals.filter(item => !item.storeId || storeIds.has(item.storeId)) };
}

async function handleWebhook(req, res, id) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return json(res, { error: 'Content-Type application/json obrigatório.', requestId: id }, 415);
  const rawBody = await readBody(req);
  const valid = IfoodApiClient.verifyWebhookSignature(rawBody, req.headers['x-ifood-signature'], process.env.IFOOD_CLIENT_SECRET);
  if (!valid) return json(res, { error: 'Assinatura inválida.', requestId: id }, 401);
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return json(res, { error: 'JSON inválido.', requestId: id }, 400); }
  if (!payload || typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 256) return json(res, { error: 'Evento sem id válido.', requestId: id }, 400);
  const duplicate = Boolean(payload.id && (ifoodSync.events.has(payload.id) || ifoodSync.processing.has(payload.id)));
  recordAudit({ action: 'IFOOD_WEBHOOK_RECEIVED', actor: 'ifood', entity: 'event', entityId: payload.id ?? payload.orderId, metadata: { code: payload.code, merchantId: payload.merchantId } });
  if (!duplicate) void ifoodSync.ingestEvent(payload).catch(error => console.error(JSON.stringify(logEntry({ level: 'error', message: 'webhook_processing_failed', requestId: requestId(), metadata: safeError(error) }))));
  return json(res, { received: true, processed: false, duplicate }, 202);
}

async function handleSync(req, res) {
  if (!ifoodClient.enabled) return json(res, { enabled: false, mode: 'DEMO', message: 'Sincronização real desativada.' }, 409);
  const environment = validateEnvironment();
  if (!environment.valid) return json(res, { enabled: true, mode: 'REAL', status: 'CONFIG_ERROR', errors: environment.errors }, 503);
  try { return json(res, await ifoodSync.syncOnce()); } catch (error) { return json(res, { error: error.message }, 502); }
}

async function handleApprovalDecision(req, res) {
  const id = req.url.split('/')[3]?.split('?')[0];
  const body = await readJson(req);
  try { return json(res, approvalInbox.decide(id, { status: body.status, actor: body.actor ?? 'admin', note: body.note ?? '' })); } catch (error) { return json(res, { error: error.message }, error.statusCode ?? 400); }
}

async function handleAuthRegister(req, res) {
  try { const body = await readJson(req); const user = auth.register(body); recordAudit({ action: 'AUTH_REGISTER', actor: user.id, entity: 'user', entityId: user.id, metadata: { companyId: user.companyId, role: user.role } }); return json(res, user, 201); } catch (error) { return json(res, { error: error.message }, error.statusCode ?? 400); }
}

async function handleAuthLogin(req, res) {
  try { const body = await readJson(req); const session = auth.login(body); recordAudit({ action: 'AUTH_LOGIN', actor: session.user.id, entity: 'session', entityId: session.user.id, metadata: { companyId: session.user.companyId } }); return json(res, session); } catch (error) { return json(res, { error: error.message }, error.statusCode ?? 401); }
}

async function handleAuthLogout(req, res) {
  let user;
  try { user = auth.authenticate(bearer(req)); } catch { user = null; }
  auth.revoke(bearer(req));
  if (user) recordAudit({ action: 'AUTH_LOGOUT', actor: user.id, entity: 'session', entityId: user.id, metadata: { companyId: user.companyId } });
  return json(res, { loggedOut: true });
}

async function handleAuthMe(req, res) {
  try { return json(res, auth.authenticate(bearer(req))); } catch (error) { return json(res, { error: error.message }, 401); }
}

function bearer(req) {
  const value = req.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function getRequestUser(req) {
  if (process.env.REQUIRE_AUTH !== 'true') return null;
  try { return auth.authenticate(bearer(req)); } catch { return null; }
}

function hasPermission(req, permission) {
  if (process.env.REQUIRE_AUTH !== 'true') return true;
  return can(getRequestUser(req), permission);
}

function visibleStores(stores, user) {
  if (!user) return stores;
  if (user.companyId !== snapshot.company.id) return [];
  if (user.role === 'OWNER' || user.role === 'ADMIN') return stores;
  const allowed = new Set(user.storeIds ?? []);
  return stores.filter(store => allowed.has(store.id));
}

function requireProtectedAuth(req) {
  if (process.env.REQUIRE_AUTH !== 'true') return true;
  try { auth.authenticate(bearer(req)); return true; } catch { return false; }
}

function isPublicApi(requestUrl) {
  const pathname = new URL(requestUrl, 'http://localhost').pathname;
  const publicPaths = ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/ifood/webhook', '/api/ifood/config', '/api/ifood/health', '/api/openapi.json'];
  if (pathname === '/api/auth/register') return !ifoodClient.enabled;
  return publicPaths.includes(pathname);
}

function allowedMethodsFor(requestUrl) {
  const pathname = new URL(requestUrl, 'http://localhost').pathname;
  if (pathname === '/api/auth/register' || pathname === '/api/auth/login' || pathname === '/api/auth/logout') return ['POST'];
  if (pathname === '/api/auth/me' || pathname === '/api/ifood/config' || pathname === '/api/ifood/health' || pathname === '/api/ifood/merchants/status' || pathname === '/api/ifood/orders' || pathname === '/api/ifood/events' || pathname === '/api/ifood/reconciliation' || pathname === '/api/demo/scenarios' || pathname === '/api/openapi.json' || pathname === '/api/system/status' || pathname === '/api/launch/readiness' || pathname === '/api/stores' || pathname === '/api/orders' || pathname === '/api/finance/summary' || pathname === '/api/metrics' || pathname === '/api/metrics/daily' || pathname === '/api/metrics/hourly' || pathname === '/api/forecasts' || pathname === '/api/catalog/analysis' || pathname === '/api/products' || pathname === '/api/reviews' || pathname === '/api/reviews/analysis' || pathname === '/api/reviews/critical' || pathname === '/api/alerts' || pathname === '/api/opportunities' || pathname === '/api/approvals' || pathname === '/api/decisions' || pathname === '/api/audit' || pathname === '/api/backup/demo.json' || pathname === '/api/reports/daily' || pathname === '/api/reports/products.csv' || pathname === '/api/reports/orders.csv' || pathname.startsWith('/api/goals')) return ['GET'];
  if (pathname === '/api/demo') return ['GET'];
  if (pathname === '/api/ifood/webhook' || pathname === '/api/ifood/sync') return ['POST'];
  if (pathname.match(/^\/api\/ifood\/merchants\/[^/]+\/interruptions$/)) return ['GET', 'POST'];
  if (pathname.match(/^\/api\/ifood\/merchants\/[^/]+\/interruptions\/[^/]+$/)) return ['DELETE'];
  if (pathname.match(/^\/api\/ifood\/orders\/[^/]+$/) || pathname.match(/^\/api\/ifood\/orders\/[^/]+\/cancellationReasons$/)) return ['GET'];
  if (pathname.match(/^\/api\/ifood\/orders\/[^/]+\/(confirm|startPreparation|readyToPickup|dispatch|requestCancellation)$/)) return ['POST'];
  if (pathname.startsWith('/api/approvals/')) return ['POST'];
  if (pathname.startsWith('/api/recovery/') || pathname.startsWith('/api/stores/') && pathname.endsWith('/health') || pathname.startsWith('/api/orders/')) return ['GET'];
  return null;
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try { return JSON.parse(body.toString('utf8')); } catch { throw new Error('JSON inválido'); }
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Payload muito grande'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? Number(value) : value)); }
function csv(res, body, filename = 'relatorio.csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' }); res.end(body); }
function attachment(res, body) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="gerente-ifood-demo-backup.json"', 'Cache-Control': 'no-store' }); res.end(body); }
function integrationHealth() {
  const env = validateEnvironment();
  return { status: env.valid ? (ifoodClient.enabled ? 'READY_FOR_SYNC' : 'DEMO_ONLY') : 'CONFIG_ERROR', integrationEnabled: ifoodClient.enabled, credentialsConfigured: Boolean(ifoodClient.clientId && ifoodClient.clientSecret), modules: { authentication: true, merchant: true, events: true, order: true, catalog: false, review: false, financial: false, analytics: false }, errors: env.errors, externalCallsAllowed: ifoodClient.enabled };
}
function send(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); }
async function handleIfoodRead(res, operation) {
  if (!ifoodClient.enabled) return json(res, { enabled: false, mode: 'DEMO', message: 'Integração real desativada.' }, 409);
  try { return json(res, await operation()); } catch (error) { return json(res, { error: error.message }, 502); }
}
export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) throw new Error('Porta inválida.');
  const listener = server.listen(normalizedPort, () => console.log(`Gerente iFood IA ${ifoodClient.enabled ? 'REAL' : 'DEMO'} em http://localhost:${normalizedPort}`));
  if (ifoodClient.enabled) ifoodSync.startPolling({ intervalMs: Number(process.env.IFOOD_POLL_INTERVAL_MS ?? 30000), onError: error => console.error(JSON.stringify(logEntry({ level: 'error', message: 'ifood_polling_failed', metadata: safeError(error) }))) });
  return listener;
}

export async function stopServer() {
  ifoodSync.stopPolling();
  if (!server.listening) return;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (persistence.mode === 'POSTGRES') {
    try {
      await persistence.migrate();
      await hydrateAudit();
      await eventRepository.hydrate?.();
      await approvalInbox.hydrate();
      for (const approval of snapshot.approvals) if (!approvalInbox.get(approval.id)) approvalInbox.create({ ...approval, companyId: snapshot.company.id });
      console.log('PostgreSQL migrado com sucesso.');
    } catch (error) {
      console.error('Falha na migração do PostgreSQL:', error.message);
      process.exitCode = 1;
      process.exit();
    }
  }
  startServer();
  const shutdown = async signal => {
    console.log(`Encerrando servidor (${signal})...`);
    try { await stopServer(); process.exitCode = 0; } catch { process.exitCode = 1; }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

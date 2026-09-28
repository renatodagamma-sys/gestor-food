import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { server, startServer } from '../src/server.js';

let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test('inicialização rejeita porta inválida', () => {
  assert.throws(() => startServer('abc'), /Porta inválida/);
  assert.throws(() => startServer(70000), /Porta inválida/);
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('API HTTP expõe cenário, metas e recuperação coerentes', async () => {
  const scenarioResponse = await fetch(`${baseUrl}/api/demo?scenario=cancellations`);
  assert.equal(scenarioResponse.status, 200);
  assert.equal(scenarioResponse.headers.get('x-request-id')?.length > 0, true);
  assert.equal(scenarioResponse.headers.get('cache-control'), 'no-store');
  const scenario = await scenarioResponse.json();
  assert.equal(scenario.scenario, 'cancellations');
  assert.equal(scenario.stores.find(store => store.id === 'store-3').status, 'CRÍTICO');

  const goals = await (await fetch(`${baseUrl}/api/goals?scenario=cancellations`)).json();
  assert.equal(goals.length, 3);

  const recovery = await (await fetch(`${baseUrl}/api/recovery/store-2?scenario=cancellations`)).json();
  assert.equal(typeof recovery.additionalOrdersEstimate, 'number');
});

test('API HTTP expõe a lista canônica de cenários DEMO', async () => {
  const response = await fetch(`${baseUrl}/api/demo/scenarios`);
  assert.deepEqual((await response.json()).scenarios, ['normal', 'weak-sales', 'critical-reviews', 'cancellations']);
});

test('endpoint de liveness informa que o processo está ativo', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', mode: 'DEMO' });
});

test('endpoint de readiness confirma DEMO pronta', async () => {
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready', mode: 'DEMO', errors: [] });
});

test('checklist de lançamento expõe pendências sem depender do iFood', async () => {
  const response = await fetch(`${baseUrl}/api/launch/readiness`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 6);
  assert.equal(body.checks.find(item => item.id === 'homologation').ready, false);
  assert.equal(body.checks.find(item => item.id === 'ifood-gate').ready, true);
});

test('contrato OpenAPI documenta os endpoints operacionais', async () => {
  const response = await fetch(`${baseUrl}/api/openapi.json`);
  assert.equal(response.status, 200);
  const contract = await response.json();
  assert.equal(contract.paths['/healthz'].get.responses['200'].description, 'Processo ativo');
  assert.equal(Boolean(contract.paths['/api/system/status']), true);
});

test('contrato OpenAPI mantém as rotas operacionais documentadas', async () => {
  const contract = await (await fetch(`${baseUrl}/api/openapi.json`)).json();
  const expectedPaths = [
    '/api/stores/{storeId}/health', '/api/orders/{orderId}', '/api/finance/summary',
    '/api/metrics', '/api/metrics/daily', '/api/metrics/hourly', '/api/forecasts',
    '/api/catalog/analysis', '/api/products', '/api/reviews', '/api/reviews/analysis',
    '/api/reviews/critical', '/api/alerts', '/api/opportunities', '/api/approvals',
    '/api/decisions', '/api/audit', '/api/reports/daily', '/api/reports/products.csv',
    '/api/reports/orders.csv'
  ];
  for (const path of expectedPaths) assert.equal(Boolean(contract.paths[path]), true, `rota ausente no OpenAPI: ${path}`);
});

test('relatório HTTP respeita cenário e nomeia o arquivo corretamente', async () => {
  const response = await fetch(`${baseUrl}/api/reports/orders.csv?scenario=cancellations`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /relatorio-pedidos\.csv/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /"Pedido";"Loja";"Status"/);
});

test('API HTTP mantém integração externa bloqueada no DEMO', async () => {
  const response = await fetch(`${baseUrl}/api/ifood/merchants/status`);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.enabled, false);
});

test('API HTTP mantém operações Merchant bloqueadas no DEMO', async () => {
  for (const path of ['/api/ifood/merchants', '/api/ifood/merchants/m1', '/api/ifood/merchants/m1/status', '/api/ifood/merchants/m1/interruptions', '/api/ifood/merchants/m1/opening-hours']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).mode, 'DEMO');
  }
});

test('API HTTP mantém operações Order bloqueadas no DEMO', async () => {
  for (const path of ['/api/ifood/orders/o1', '/api/ifood/orders/o1/cancellationReasons']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).mode, 'DEMO');
  }
});

test('webhook HTTP responde 202 após validar assinatura', async () => {
  const previousSecret = process.env.IFOOD_CLIENT_SECRET;
  process.env.IFOOD_CLIENT_SECRET = 'webhook-test-secret';
  try {
    const body = JSON.stringify({ id: `event-${Date.now()}`, code: 'PLC', orderId: 'order-webhook' });
    const signature = createHmac('sha256', process.env.IFOOD_CLIENT_SECRET).update(body).digest('hex');
    const response = await fetch(`${baseUrl}/api/ifood/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifood-signature': signature }, body });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).received, true);
    const contract = await (await fetch(`${baseUrl}/api/openapi.json`)).json();
    assert.equal(contract.paths['/api/ifood/webhook'].post.responses['202'].description, 'Recebido e aceito para processamento');
  } finally {
    if (previousSecret === undefined) delete process.env.IFOOD_CLIENT_SECRET;
    else process.env.IFOOD_CLIENT_SECRET = previousSecret;
  }
});

test('webhook HTTP rejeita evento sem id deduplicável', async () => {
  const previousSecret = process.env.IFOOD_CLIENT_SECRET;
  process.env.IFOOD_CLIENT_SECRET = 'webhook-test-secret';
  try {
    const body = JSON.stringify({ code: 'PLC', orderId: 'order-without-event-id' });
    const signature = createHmac('sha256', process.env.IFOOD_CLIENT_SECRET).update(body).digest('hex');
    const response = await fetch(`${baseUrl}/api/ifood/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifood-signature': signature }, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Evento sem id válido.');
  } finally {
    if (previousSecret === undefined) delete process.env.IFOOD_CLIENT_SECRET;
    else process.env.IFOOD_CLIENT_SECRET = previousSecret;
  }
});

test('webhook HTTP rejeita id de evento excessivamente grande', async () => {
  const previousSecret = process.env.IFOOD_CLIENT_SECRET;
  process.env.IFOOD_CLIENT_SECRET = 'webhook-test-secret';
  try {
    const body = JSON.stringify({ id: 'x'.repeat(257) });
    const signature = createHmac('sha256', process.env.IFOOD_CLIENT_SECRET).update(body).digest('hex');
    const response = await fetch(`${baseUrl}/api/ifood/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifood-signature': signature }, body });
    assert.equal(response.status, 400);
  } finally {
    if (previousSecret === undefined) delete process.env.IFOOD_CLIENT_SECRET;
    else process.env.IFOOD_CLIENT_SECRET = previousSecret;
  }
});

test('webhook HTTP retorna erro JSON com requestId para assinatura inválida', async () => {
  const response = await fetch(`${baseUrl}/api/ifood/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifood-signature': 'invalid' }, body: JSON.stringify({ id: 'event-invalid-signature' }) });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'Assinatura inválida.');
  assert.equal(typeof body.requestId, 'string');
});

test('webhook HTTP exige Content-Type JSON', async () => {
  const response = await fetch(`${baseUrl}/api/ifood/webhook`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-ifood-signature': 'invalid' }, body: '{}' });
  assert.equal(response.status, 415);
  const body = await response.json();
  assert.equal(body.error, 'Content-Type application/json obrigatório.');
  assert.equal(typeof body.requestId, 'string');
});

test('fluxo HTTP de autenticação não devolve hash e revoga sessão', async () => {
  const email = `http-${Date.now()}@demo.local`;
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `http-${Date.now()}`, email, password: 'senha-segura', companyId: 'company-demo' })
  });
  assert.equal(registerResponse.status, 201);
  assert.equal('passwordHash' in await registerResponse.json(), false);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.toUpperCase(), password: 'senha-segura' })
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  assert.equal('passwordHash' in login.user, false);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${login.token}` } });
  const me = await meResponse.json();
  assert.equal(meResponse.status, 200);
  assert.equal('passwordHash' in me, false);

  await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${login.token}` } });
  const revoked = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${login.token}` } });
  assert.equal(revoked.status, 401);
});

test('modo protegido exige autenticação para dados operacionais', async () => {
  const previous = process.env.REQUIRE_AUTH;
  process.env.REQUIRE_AUTH = 'true';
  try {
    const response = await fetch(`${baseUrl}/api/stores`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Autenticação obrigatória.');
    assert.equal(typeof body.requestId, 'string');
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previous;
  }
});

test('modo protegido limita dados ao vínculo de loja do usuário', async () => {
  const email = `manager-${Date.now()}@demo.local`;
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `manager-${Date.now()}`, email, password: 'senha-segura', companyId: 'company-demo', role: 'MANAGER', storeIds: ['store-1'] })
  });
  assert.equal(registerResponse.status, 201);
  const login = await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'senha-segura' }) })).json();
  const previous = process.env.REQUIRE_AUTH;
  process.env.REQUIRE_AUTH = 'true';
  try {
    const headers = { authorization: `Bearer ${login.token}` };
    const stores = await (await fetch(`${baseUrl}/api/stores`, { headers })).json();
    assert.deepEqual(stores.map(store => store.id), ['store-1']);
    const orders = await (await fetch(`${baseUrl}/api/orders`, { headers })).json();
    assert.equal(orders.every(order => order.storeId === 'store-1'), true);
    const products = await (await fetch(`${baseUrl}/api/products`, { headers })).json();
    assert.equal(products.every(product => product.storeId === 'store-1'), true);
    const reviews = await (await fetch(`${baseUrl}/api/reviews`, { headers })).json();
    assert.equal(reviews.every(review => review.storeId === 'store-1'), true);
    const report = await (await fetch(`${baseUrl}/api/reports/orders.csv`, { headers })).text();
    assert.equal(report.includes('store-2'), false);
    const backup = await fetch(`${baseUrl}/api/backup/demo.json`, { headers });
    assert.equal(backup.status, 403);
    const approval = await fetch(`${baseUrl}/api/approvals/approval-1`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'APPROVED' }) });
    assert.equal(approval.status, 403);
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previous;
  }
});

test('RBAC bloqueia ações administrativas de analista', async () => {
  const email = `analyst-${Date.now()}@demo.local`;
  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `analyst-${Date.now()}`, email, password: 'senha-segura', companyId: 'company-demo', role: 'ANALYST', storeIds: ['store-1'] })
  });
  const login = await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'senha-segura' }) })).json();
  const previous = process.env.REQUIRE_AUTH;
  process.env.REQUIRE_AUTH = 'true';
  try {
    const headers = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
    const approval = await fetch(`${baseUrl}/api/approvals/approval-1`, { method: 'POST', headers, body: JSON.stringify({ status: 'APPROVED' }) });
    assert.equal(approval.status, 403);
    const audit = await fetch(`${baseUrl}/api/audit`, { headers });
    assert.equal(audit.status, 403);
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previous;
  }
});

test('API HTTP rejeita rota inexistente sem expor detalhes internos', async () => {
  const response = await fetch(`${baseUrl}/api/rota-inexistente`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, 'Rota API não encontrada.');
  assert.equal(typeof body.requestId, 'string');
});

test('API HTTP padroniza recurso inexistente em JSON', async () => {
  const response = await fetch(`${baseUrl}/api/orders/order-inexistente`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error, 'Pedido não encontrado.');
  assert.equal(typeof body.requestId, 'string');
});

test('API HTTP rejeita método não permitido com Allow', async () => {
  const response = await fetch(`${baseUrl}/api/stores`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal((await response.json()).error, 'Método HTTP não permitido.');
});

test('servidor bloqueia traversal de arquivos estáticos', async () => {
  const response = await fetch(`${baseUrl}/../package.json`);
  assert.equal(response.status, 404);
});

test('API HTTP rejeita payload JSON acima do limite', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'large@example.com', password: 'x'.repeat(1024 * 1024) })
  });
  assert.equal(response.status, 413);
  assert.equal(await response.text(), JSON.stringify({ error: 'Payload muito grande' }));
});

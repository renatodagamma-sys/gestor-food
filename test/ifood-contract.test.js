import test from 'node:test';
import assert from 'node:assert/strict';
import { IfoodContractMockClient } from '../src/integrations/ifood/mock-client.js';
import { IfoodSyncService, MemoryEventRepository, MemoryOrderRepository } from '../src/integrations/ifood/sync-service.js';

test('simulador cobre o contrato Merchant, Catalog e Review sem rede externa', async () => {
  const client = new IfoodContractMockClient();
  assert.equal((await client.listMerchants()).length, 1);
  assert.equal((await client.getMerchantStatus('merchant-test')).status, 'OPEN');
  const interruption = await client.createMerchantInterruption('merchant-test', { start: '10:00', end: '11:00' });
  assert.equal((await client.getMerchantInterruptions('merchant-test')).length, 1);
  await client.deleteMerchantInterruption('merchant-test', interruption.id);
  assert.equal((await client.listCatalogs('merchant-test')).length, 1);
  assert.equal((await client.listSellableItems('merchant-test', 'catalog-test')).length, 1);
  assert.equal((await client.listReviews('merchant-test')).length, 1);
  await client.replyReview('merchant-test', 'review-test', 'Obrigado!');
  await client.createCatalogItem('merchant-test', 'catalog-test', { name: 'Novo item', price: 1990 });
  await client.updateCatalogItem('merchant-test', 'catalog-test', 'item-1', { price: 2190 });
  await client.quoteDelivery('merchant-test', { orderId: 'order-test' });
  await client.createDelivery('merchant-test', { orderId: 'order-test' });
  await client.getDelivery('merchant-test', 'delivery-test');
  assert.equal((await client.listReviews('merchant-test'))[0].answered, true);
  assert.ok(client.calls.every(call => !call.path.includes('merchant-api')));
  assert.equal(client.calls.some(call => call.path.includes('/shipping/v1.0/')), true);
});

test('simulador cobre ciclo de pedido e polling com acknowledgment', async () => {
  const client = new IfoodContractMockClient();
  const sync = new IfoodSyncService({ client, eventRepository: new MemoryEventRepository(), orderRepository: new MemoryOrderRepository() });
  const result = await sync.syncOnce();
  assert.deepEqual(result, { received: 1, processed: 1, acknowledged: ['event-test'] });
  assert.equal(sync.orders.get('order-test').status, 'PLACED');
  await client.confirmOrder('order-test');
  await client.startPreparation('order-test');
  await client.readyToPickup('order-test');
  await client.dispatchOrder('order-test');
  assert.equal((await client.getOrder('order-test')).status, 'DISPATCHED');
  assert.deepEqual(client.calls.at(-1), { method: 'GET', path: '/order/v1.0/orders/order-test', payload: undefined });
});

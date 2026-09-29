export class IfoodContractMockClient {
  constructor() {
    this.calls = [];
    this.merchant = { id: 'merchant-test', name: 'Loja de Teste', status: 'OPEN' };
    this.interruptions = [];
    this.orders = new Map([['order-test', { id: 'order-test', status: 'PLACED', merchantId: this.merchant.id, customer: { name: 'Cliente Demo' }, items: [{ id: 'item-1', name: 'Produto Demo', quantity: 1 }], payments: [{ type: 'CREDIT_CARD', value: 2990 }], benefits: [], delivery: { mode: 'DELIVERY' } }]]);
    this.events = [{ id: 'event-test', code: 'PLACED', orderId: 'order-test', merchantId: this.merchant.id }];
    this.reviews = [{ id: 'review-test', rating: 5, comment: 'Atendimento excelente', answered: false }];
  }

  call(method, path, payload) { this.calls.push({ method, path, payload }); }
  async listMerchants() { this.call('GET', '/merchant/v1.0/merchants'); return [this.merchant]; }
  async getMerchant(id) { this.call('GET', `/merchant/v1.0/merchants/${id}`); return id === this.merchant.id ? this.merchant : null; }
  async getMerchantStatus(id) { this.call('GET', `/merchant/v1.0/merchants/${id}/status`); return { merchantId: id, status: this.merchant.status }; }
  async getMerchantInterruptions(id) { this.call('GET', `/merchant/v1.0/merchants/${id}/interruptions`); return this.interruptions.filter(item => item.merchantId === id); }
  async createMerchantInterruption(id, interruption) { this.call('POST', `/merchant/v1.0/merchants/${id}/interruptions`, interruption); const row = { id: `interruption-${this.interruptions.length + 1}`, merchantId: id, ...interruption }; this.interruptions.push(row); return row; }
  async deleteMerchantInterruption(id, interruptionId) { this.call('DELETE', `/merchant/v1.0/merchants/${id}/interruptions/${interruptionId}`); this.interruptions = this.interruptions.filter(item => item.id !== interruptionId || item.merchantId !== id); return null; }
  async getOpeningHours(id) { this.call('GET', `/merchant/v1.0/merchants/${id}/opening-hours`); return { merchantId: id, openingHours: [{ dayOfWeek: 'MONDAY', start: '10:00', end: '22:00' }] }; }
  async getOrder(id) { this.call('GET', `/order/v1.0/orders/${id}`); return this.orders.get(id) ?? null; }
  async getCancellationReasons(id) { this.call('GET', `/order/v1.0/orders/${id}/cancellationReasons`); return [{ code: 'OUT_OF_STOCK', description: 'Indisponibilidade de item' }]; }
  async transition(id, status, payload) { this.call('POST', `/order/v1.0/orders/${id}/${status}`, payload); const order = this.orders.get(id); if (order) order.status = status; return { id, status }; }
  confirmOrder(id) { return this.transition(id, 'CONFIRMED'); }
  startPreparation(id) { return this.transition(id, 'PREPARING'); }
  readyToPickup(id) { return this.transition(id, 'READY_TO_PICKUP'); }
  dispatchOrder(id, deliveredBy = 'MERCHANT') { return this.transition(id, 'DISPATCHED', { deliveredBy }); }
  requestCancellation(id, reason) { return this.transition(id, 'CANCELLATION_REQUESTED', reason ?? {}); }
  async listCatalogs(id) { this.call('GET', `/catalog/v2.0/merchants/${id}/catalogs`); return [{ id: 'catalog-test', name: 'Catálogo Demo' }]; }
  async listSellableItems(id, catalogId) { this.call('GET', `/catalog/v2.0/merchants/${id}/catalogs/${catalogId}/sellableItems`); return [{ id: 'item-1', name: 'Produto Demo', price: 2990, status: 'AVAILABLE' }]; }
  async listReviews(id) { this.call('GET', `/review/v2.0/merchants/${id}/reviews`); return this.reviews; }
  async replyReview(id, reviewId, text) { this.call('POST', `/review/v2.0/merchants/${id}/reviews/${reviewId}/answers`, { text }); const review = this.reviews.find(item => item.id === reviewId); if (review) review.answered = true; return { id: reviewId, text }; }
  async pollEvents() { this.call('GET', '/order/v1.0/events:polling'); return { events: this.events.splice(0) }; }
  async acknowledgeEvents(eventIds) { this.call('POST', '/order/v1.0/events/acknowledgment', { acknowledgedEventIds: eventIds }); return { acknowledgedEventIds: eventIds }; }
}

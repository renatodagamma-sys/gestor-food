const REQUIREMENTS = [
  { id: 'merchant.read', module: 'Merchant', label: 'Consultar lojas, status, pausas e horários', codeReady: true, external: true },
  { id: 'merchant.write', module: 'Merchant', label: 'Criar e excluir pausas operacionais com permissão', codeReady: true, external: true },
  { id: 'events.poll', module: 'Orders/Events', label: 'Polling com intervalo mínimo de 30 segundos', codeReady: true, external: true },
  { id: 'events.ack', module: 'Orders/Events', label: 'Acknowledgment e deduplicação por event.id', codeReady: true, external: true },
  { id: 'orders.lifecycle', module: 'Orders/Events', label: 'Consultar pedido e executar ciclo operacional controlado', codeReady: true, external: true },
  { id: 'orders.payload', module: 'Orders/Events', label: 'Preservar cliente, itens, pagamentos, benefícios e entrega', codeReady: true, external: true },
  { id: 'catalog.read', module: 'Catalog', label: 'Consultar catálogos e itens vendáveis', codeReady: true, external: true },
  { id: 'catalog.write', module: 'Catalog', label: 'Criar e atualizar categorias, produtos, complementos, preços e imagens', codeReady: false, external: true },
  { id: 'shipping', module: 'Shipping', label: 'Criar, cotar e rastrear entregas', codeReady: false, external: true },
  { id: 'review.read', module: 'Review', label: 'Listar avaliações e exibir resumo na interface', codeReady: true, external: true },
  { id: 'review.write', module: 'Review', label: 'Responder avaliações com aprovação', codeReady: true, external: true },
  { id: 'review.policy', module: 'Review', label: 'Exibir link da Política de Avaliações do iFood', codeReady: false, external: true },
  { id: 'financial', module: 'Financial', label: 'Validar módulo financeiro em chamado específico', codeReady: false, external: true }
];

export function buildComplianceReport({ integrationMode = 'DEMO' } = {}) {
  const checks = REQUIREMENTS.map(item => ({
    ...item,
    status: item.codeReady ? 'CONTRATO_PRONTO' : 'PENDENTE_IMPLEMENTACAO',
    verified: false,
    detail: item.codeReady
      ? 'Coberto por contrato, testes locais e simulador; falta validação oficial.'
      : 'Ainda precisa de implementação e testes antes da homologação.'
  }));
  const implemented = checks.filter(item => item.codeReady).length;
  const external = checks.filter(item => item.external).length;
  return {
    generatedAt: new Date().toISOString(),
    integrationMode,
    disclaimer: 'Relatório técnico local; não substitui homologação oficial nem confirma acesso a módulos do iFood.',
    summary: { total: checks.length, implemented, pendingImplementation: checks.length - implemented, externalValidationPending: external },
    modules: [...new Set(checks.map(item => item.module))].map(module => {
      const items = checks.filter(item => item.module === module);
      return { module, total: items.length, implemented: items.filter(item => item.codeReady).length, checks: items };
    }),
    checks
  };
}

export { REQUIREMENTS };

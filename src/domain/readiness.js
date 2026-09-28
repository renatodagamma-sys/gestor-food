export function buildLaunchReadiness({ integration, system, persistenceMode }) {
  const checks = [
    { id: 'demo', label: 'Aplicação publicada em modo DEMO', ready: true, detail: 'Ambiente público disponível sem chamadas externas.' },
    { id: 'database', label: 'Persistência operacional', ready: persistenceMode === 'POSTGRES', detail: persistenceMode === 'POSTGRES' ? 'PostgreSQL conectado.' : 'Ambiente em memória; configure DATABASE_URL.' },
    { id: 'cost-lock', label: 'Custos externos bloqueados', ready: system.costsBlocked, detail: system.costsBlocked ? 'COSTS_ENABLED permanece desativado.' : 'Bloqueie custos antes de liberar a operação.' },
    { id: 'auth', label: 'Autenticação obrigatória', ready: system.authRequired, detail: system.authRequired ? 'Acesso protegido por sessão e permissões.' : 'Ative REQUIRE_AUTH antes de usuários reais.' },
    { id: 'ifood-gate', label: 'Integração iFood controlada', ready: integration.mode === 'DEMO', detail: integration.mode === 'DEMO' ? 'Integração aguarda homologação.' : 'Integração real habilitada.' },
    { id: 'homologation', label: 'Homologação iFood', ready: false, detail: 'Aguardando aprovação do ticket 34017713.' }
  ];
  const completed = checks.filter(check => check.ready).length;
  return { completed, total: checks.length, percent: Math.round(completed / checks.length * 100), checks };
}

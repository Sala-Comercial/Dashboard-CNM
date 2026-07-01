/* ════════════════════════════════════════════════════════════════════
   API /api/data  —  Vercel Serverless Function
   --------------------------------------------------------------------
   Busca dados AO VIVO no HubSpot (api.hubapi.com) usando o token
   guardado na variável de ambiente HUBSPOT_TOKEN (NUNCA no HTML).
   Devolve exatamente o mesmo formato consumido pelos renderizadores
   do dashboard (o antigo snapshot __CNM26_STATIC_DATA__).

   Envelope de resposta (igual ao esperado pelo frontend):
     { available: true,  status: { ok: true },           data: { ... } }
     { available: false, status: { ok: false, error } }

   FASE 1: contacts + owners + deals + segmentações (calculadas em JS,
           substituindo o GROUP BY do SQL cruzado).
           meetings e dealActivities entram na Fase 2.
════════════════════════════════════════════════════════════════════ */

const HUBSPOT_BASE = 'https://api.hubapi.com';
const CAMPANHA = 'Cidade Na Mão 2026';

// Propriedades de CONTACT — exatamente as mesmas do código MCP original.
const CONTACT_PROPS = [
  'hs_full_name_or_email', 'hubspot_owner_id', 'conectado', 'conectado_',
  'tentativas_de_conexao', 'data_da_qualificacao_', 'data_de_conectado',
  'forma_de_conexao', 'createdate', 'origem_do_contato', 'regiao',
  'unqualified_reason', 'campanha'
];

// Propriedades de DEAL — idem.
const DEAL_PROPS = [
  'dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id',
  'createdate', 'pipeline', 'origem_do_negocio', 'lost_reason__list_'
];

// Contatos de teste excluídos da contagem (mesma regra do buildLiveData).
const TEST_CONTACT_NAMES = ['karol castilho'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Chamada genérica ao HubSpot, com retry/backoff em 429 e 5xx ──────
// A Search API do HubSpot limita ~4 req/segundo; na rede rápida da Vercel
// isso estoura fácil, então reexecutamos respeitando o Retry-After.
async function hsFetch(token, path, options = {}) {
  const MAX_TRIES = 6;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const res = await fetch(HUBSPOT_BASE + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (res.ok) return res.json();

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
      const retryAfter = parseFloat(res.headers.get('Retry-After'));
      const waitMs = !isNaN(retryAfter) ? retryAfter * 1000 : Math.min(1000 * attempt, 5000);
      await sleep(waitMs);
      continue;
    }
    const body = await res.text();
    throw new Error('HubSpot ' + res.status + ' em ' + path + ': ' + body.slice(0, 300));
  }
}

// ── Search paginado (CONTACT / DEAL) filtrando pela campanha ─────────
async function searchAll(token, objectType, properties) {
  const all = [];
  let after;
  for (let page = 0; page < 200; page++) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'campanha', operator: 'EQ', value: CAMPANHA }] }],
      properties,
      limit: 100
    };
    if (after) body.after = after;
    const data = await hsFetch(token, '/crm/v3/objects/' + objectType + '/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    (data.results || []).forEach(r => all.push({ id: String(r.id), properties: r.properties || {} }));
    after = data.paging && data.paging.next && data.paging.next.after;
    if (!after) break;
    await sleep(260); // respeita o limite de ~4 buscas/segundo do HubSpot
  }
  return all;
}

// ── Owners → mapa { id: nome } (mesmo formato de fetchAllOwners) ─────
async function fetchOwners(token) {
  const map = {};
  let after;
  for (let page = 0; page < 50; page++) {
    const q = after ? '?limit=100&after=' + after : '?limit=100';
    const data = await hsFetch(token, '/crm/v3/owners' + q);
    (data.results || []).forEach(o => {
      const id = String(o.id || o.ownerId);
      const name = (o.firstName || o.lastName)
        ? [o.firstName, o.lastName].filter(Boolean).join(' ').trim()
        : (o.email || ('Owner ' + id));
      map[id] = name;
    });
    after = data.paging && data.paging.next && data.paging.next.after;
    if (!after) break;
  }
  return map;
}

// ── Pipelines de negócio (nome + ordem de cada pipeline/etapa) ───────
// O ID de etapa (dealstage) é único por pipeline no HubSpot, mas pipelines
// diferentes costumam ter etapas com o MESMO nome (ex.: "Oportunidade" em
// mais de uma pipeline). Sem saber de qual pipeline cada etapa é, a UI não
// tem como distinguir/ordenar corretamente — por isso buscamos aqui a lista
// real de pipelines em vez de confiar só num mapa fixo de nomes.
async function fetchPipelines(token) {
  const data = await hsFetch(token, '/crm/v3/pipelines/deals');
  return (data.results || []).map(p => ({
    id: String(p.id),
    label: p.label,
    displayOrder: p.displayOrder,
    stages: (p.stages || []).map(s => ({ id: String(s.id), label: s.label, displayOrder: s.displayOrder }))
  }));
}

// ── Util: divide um array em lotes de tamanho n ─────────────────────
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Associations v4 em lote: fromType → toType (até 1000 ids/req) ────
// Devolve um mapa { fromId: [toId, toId, ...] }
async function batchReadAssociations(token, fromType, toType, ids) {
  const map = {};
  for (const part of chunk(ids, 1000)) {
    const data = await hsFetch(token, '/crm/v4/associations/' + fromType + '/' + toType + '/batch/read', {
      method: 'POST',
      body: JSON.stringify({ inputs: part.map(id => ({ id: String(id) })) })
    });
    (data.results || []).forEach(r => {
      const fromId = String(r.from && r.from.id);
      const tos = (r.to || []).map(t => String(t.toObjectId));
      map[fromId] = (map[fromId] || []).concat(tos);
    });
  }
  return map;
}

// ── Batch read de objetos (até 100 ids/req) ─────────────────────────
// Devolve um mapa { id: { id, properties } }
async function batchReadObjects(token, objectType, ids, properties) {
  const map = {};
  const uniq = [...new Set(ids.map(String))];
  for (const part of chunk(uniq, 100)) {
    const data = await hsFetch(token, '/crm/v3/objects/' + objectType + '/batch/read', {
      method: 'POST',
      body: JSON.stringify({ inputs: part.map(id => ({ id: String(id) })), properties })
    });
    (data.results || []).forEach(r => { map[String(r.id)] = { id: String(r.id), properties: r.properties || {} }; });
  }
  return map;
}

/* ── Reuniões (substitui o SQL cruzado fetchReunioesLiveRaw) ──────────
   Para cada contato da campanha, pega as reuniões associadas e devolve
   uma linha por par contato↔reunião no mesmo shape que meetingsStats lê:
   { hs_object_id (contato), hubspot_owner_id (dono da reunião),
     hs_meeting_outcome (código cru — extractOutcomeCode resolve),
     hs_meeting_start_time (quando a reunião acontece/aconteceu),
     hs_createdate (quando o registro da reunião foi criado no HubSpot —
     é essa data que a aba Metas usa para encaixar a reunião na quinzena,
     não a data agendada). */
async function fetchMeetings(token, contactIds) {
  const assoc = await batchReadAssociations(token, 'contacts', 'meetings', contactIds);
  const allMeetingIds = [...new Set(Object.values(assoc).flat())];
  if (!allMeetingIds.length) return [];
  const meetingMap = await batchReadObjects(token, 'meetings', allMeetingIds,
    ['hs_meeting_outcome', 'hs_meeting_start_time', 'hubspot_owner_id', 'hs_createdate']);
  const rows = [];
  Object.keys(assoc).forEach(contactId => {
    assoc[contactId].forEach(meetingId => {
      const m = meetingMap[meetingId];
      if (!m) return;
      rows.push({
        hs_object_id: contactId,
        hubspot_owner_id: m.properties.hubspot_owner_id || '',
        hs_meeting_outcome: m.properties.hs_meeting_outcome || '',
        hs_meeting_start_time: m.properties.hs_meeting_start_time || '',
        hs_createdate: m.properties.hs_createdate || ''
      });
    });
  });
  return rows;
}

/* ── Atividades por negócio (ligações + reuniões) ────────────────────
   Mesmo shape de fetchDealActivities: { dealId: { calls, meetings } },
   cada item como { id, properties }. */
async function fetchDealActivities(token, dealIds) {
  const result = {};
  dealIds.forEach(id => { result[String(id)] = { calls: [], meetings: [] }; });
  if (!dealIds.length) return result;

  const callAssoc = await batchReadAssociations(token, 'deals', 'calls', dealIds);
  const meetAssoc = await batchReadAssociations(token, 'deals', 'meetings', dealIds);

  const callMap = await batchReadObjects(token, 'calls',
    [...new Set(Object.values(callAssoc).flat())],
    ['hs_timestamp', 'hs_call_title', 'hubspot_owner_id']);
  const meetMap = await batchReadObjects(token, 'meetings',
    [...new Set(Object.values(meetAssoc).flat())],
    ['hs_meeting_start_time', 'hs_meeting_outcome', 'hubspot_owner_id']);

  Object.keys(callAssoc).forEach(dealId => {
    result[dealId] = result[dealId] || { calls: [], meetings: [] };
    result[dealId].calls = callAssoc[dealId].map(id => callMap[id]).filter(Boolean);
  });
  Object.keys(meetAssoc).forEach(dealId => {
    result[dealId] = result[dealId] || { calls: [], meetings: [] };
    result[dealId].meetings = meetAssoc[dealId].map(id => meetMap[id]).filter(Boolean);
  });
  return result;
}

/* ── Ligações por contato (relatório "Resultado das Ligações" e a coluna
   "Tentativas de Ligações" do relatório combinado) ────────────────────
   Uma linha por par contato↔ligação: { hs_object_id, hubspot_owner_id,
   hs_call_disposition (código bruto — resolvido via callDispositionLabels),
   hs_timestamp }. */
async function fetchCalls(token, contactIds) {
  const assoc = await batchReadAssociations(token, 'contacts', 'calls', contactIds);
  const allIds = [...new Set(Object.values(assoc).flat())];
  if (!allIds.length) return [];
  const callMap = await batchReadObjects(token, 'calls', allIds,
    ['hs_call_disposition', 'hs_timestamp', 'hubspot_owner_id']);
  const rows = [];
  Object.keys(assoc).forEach(contactId => {
    assoc[contactId].forEach(callId => {
      const c = callMap[callId];
      if (!c) return;
      rows.push({
        hs_object_id: contactId,
        hubspot_owner_id: c.properties.hubspot_owner_id || '',
        hs_call_disposition: c.properties.hs_call_disposition || '',
        hs_timestamp: c.properties.hs_timestamp || ''
      });
    });
  });
  return rows;
}

// Mapa código→label do resultado da ligação (hs_call_disposition é uma
// enumeração cujos values são GUIDs — sem essa consulta, a UI mostraria o
// GUID cru em vez de "Sem resposta", "Número errado" etc.).
async function fetchCallDispositionLabels(token) {
  const data = await hsFetch(token, '/crm/v3/properties/calls/hs_call_disposition');
  const map = {};
  (data.options || []).forEach(o => { map[o.value] = o.label; });
  return map;
}

/* ── E-mails por contato ("Envio de E-mail" do relatório combinado) ──── */
async function fetchEmails(token, contactIds) {
  const assoc = await batchReadAssociations(token, 'contacts', 'emails', contactIds);
  const allIds = [...new Set(Object.values(assoc).flat())];
  if (!allIds.length) return [];
  const emailMap = await batchReadObjects(token, 'emails', allIds, ['hs_timestamp', 'hubspot_owner_id']);
  const rows = [];
  Object.keys(assoc).forEach(contactId => {
    assoc[contactId].forEach(emailId => {
      const e = emailMap[emailId];
      if (!e) return;
      rows.push({ hs_object_id: contactId, hubspot_owner_id: e.properties.hubspot_owner_id || '', hs_timestamp: e.properties.hs_timestamp || '' });
    });
  });
  return rows;
}

/* ── WhatsApp por contato ("Envio de WhatsApp" do relatório combinado) ──
   OBS: usa o mesmo tipo de objeto (Communications) que já está documentado
   como bloqueado pela allowlist do conector usado em outras partes deste
   projeto. Aqui usamos a API REST direta com o token da Vercel, que pode
   ter acesso diferente — mas se a conta/token não tiver o escopo de
   Communications, esta busca falha e cai no catch do handler (mesmo padrão
   de reuniões/atividades), deixando "indisponível" claro na UI em vez de
   fingir um resultado. */
async function fetchWhatsapp(token, contactIds) {
  const assoc = await batchReadAssociations(token, 'contacts', 'communications', contactIds);
  const allIds = [...new Set(Object.values(assoc).flat())];
  if (!allIds.length) return [];
  const commMap = await batchReadObjects(token, 'communications', allIds,
    ['hs_communication_channel_type', 'hs_timestamp', 'hubspot_owner_id']);
  const rows = [];
  Object.keys(assoc).forEach(contactId => {
    assoc[contactId].forEach(commId => {
      const c = commMap[commId];
      if (!c) return;
      if (String(c.properties.hs_communication_channel_type || '').toUpperCase() !== 'WHATS_APP') return;
      rows.push({ hs_object_id: contactId, hubspot_owner_id: c.properties.hubspot_owner_id || '', hs_timestamp: c.properties.hs_timestamp || '' });
    });
  });
  return rows;
}

/* ── Segmentações ─────────────────────────────────────────────────────
   O SQL cruzado (query_crm_data) não existe na API REST. Como já temos
   TODOS os contatos da campanha em memória, reproduzimos o GROUP BY em
   JS, devolvendo o mesmo shape { cols, rows } que os renderizadores leem. */
function groupBy1(contacts, prop) {
  const counts = {};
  contacts.forEach(c => {
    const v = (((c.properties || {})[prop]) || '').trim() || '(vazio)';
    counts[v] = (counts[v] || 0) + 1;
  });
  return {
    cols: [{ label: prop, key: prop }, { label: 'COUNT(*)', key: 'COUNT(*)' }],
    rows: Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map(k => ({ [prop]: k, 'COUNT(*)': String(counts[k]) }))
  };
}

function groupBy2(contacts, propA, propB) {
  const counts = {};
  contacts.forEach(c => {
    const p = c.properties || {};
    const a = ((p[propA]) || '').trim() || '(vazio)';
    const b = ((p[propB]) || '').trim() || '(vazio)';
    const key = a + ' ' + b;
    counts[key] = (counts[key] || 0) + 1;
  });
  return {
    cols: [{ label: propA, key: propA }, { label: propB, key: propB }, { label: 'COUNT(*)', key: 'COUNT(*)' }],
    rows: Object.keys(counts).map(k => {
      const parts = k.split(' ');
      return { [propA]: parts[0], [propB]: parts[1], 'COUNT(*)': String(counts[k]) };
    })
  };
}

// ── Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // O botão "Atualizar agora" do dashboard manda ?fresh=1 para forçar uma
  // busca de verdade no HubSpot, ignorando o cache de borda da Vercel abaixo.
  // Sem isso, um clique dentro da janela de cache (s-maxage/stale-while-
  // revalidate) devolvia uma resposta antiga sem a função sequer rodar de
  // novo — o usuário via "Atualizado" mas os dados continuavam velhos.
  const forceFresh = String((req.query && req.query.fresh) || '') === '1';

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    res.status(200).json({
      available: false,
      status: { ok: false, error: 'HUBSPOT_TOKEN não configurado nas variáveis de ambiente da Vercel.' }
    });
    return;
  }

  try {
    const contactsRaw = await searchAll(token, 'contacts', CONTACT_PROPS);
    const contacts = contactsRaw.filter(c => {
      const nm = (((c.properties && c.properties.hs_full_name_or_email)) || '').trim().toLowerCase();
      return !TEST_CONTACT_NAMES.includes(nm);
    });

    const owners = await fetchOwners(token);
    const deals = await searchAll(token, 'deals', DEAL_PROPS);

    let pipelines = [];
    let pipelinesError = null;
    try {
      pipelines = await fetchPipelines(token);
    } catch (e) {
      pipelinesError = e.message;
      console.warn('Falha ao buscar pipelines:', e.message);
    }

    // Fase 2: reuniões (por contato) e atividades (por negócio) via Associations API.
    // Em caso de falha pontual, meetings cai para null (a UI já trata "indisponível").
    let meetings = null;
    let meetingsError = null;
    try {
      meetings = await fetchMeetings(token, contacts.map(c => c.id));
    } catch (e) {
      meetingsError = e.message;
      console.warn('Falha ao buscar reuniões:', e.message);
    }
    let dealActivities = {};
    let dealActivitiesError = null;
    try {
      dealActivities = await fetchDealActivities(token, deals.map(d => d.id));
    } catch (e) {
      dealActivitiesError = e.message;
      console.warn('Falha ao buscar atividades de negócios:', e.message);
    }

    const contactIds = contacts.map(c => c.id);
    let calls = null;
    let callsError = null;
    let callDispositionLabels = {};
    try {
      calls = await fetchCalls(token, contactIds);
      try { callDispositionLabels = await fetchCallDispositionLabels(token); } catch (e) { /* segue sem os labels — UI cai pro código bruto */ }
    } catch (e) {
      callsError = e.message;
      console.warn('Falha ao buscar ligações:', e.message);
    }
    let emails = null;
    let emailsError = null;
    try {
      emails = await fetchEmails(token, contactIds);
    } catch (e) {
      emailsError = e.message;
      console.warn('Falha ao buscar e-mails:', e.message);
    }
    let whatsapps = null;
    let whatsappsError = null;
    try {
      whatsapps = await fetchWhatsapp(token, contactIds);
    } catch (e) {
      whatsappsError = e.message;
      console.warn('Falha ao buscar WhatsApp (Communications pode estar bloqueado nesta integração):', e.message);
    }

    const fetchedAt = new Date().toISOString();
    const data = {
      contacts,
      owners,
      deals,
      meetings,
      dealActivities,
      pipelines,
      calls,
      callDispositionLabels,
      emails,
      whatsapps,
      segByOrigem: groupBy1(contacts, 'origem_do_contato'),
      segByRegiao: groupBy1(contacts, 'regiao'),
      unqualByReason: groupBy1(contacts, 'unqualified_reason'),
      origemConectado: groupBy2(contacts, 'origem_do_contato', 'conectado_'),
      regiaoConectado: groupBy2(contacts, 'regiao', 'conectado_'),
      fetchedAt,
      // Rastreabilidade da sincronização: permite a UI mostrar com confiança
      // que o clique em "Atualizar agora" realmente foi buscar no HubSpot
      // (e não uma resposta antiga do cache de borda), com contagens e
      // eventuais falhas parciais de cada etapa da busca.
      sync: {
        forced: forceFresh,
        fetchedAt,
        contactsCount: contacts.length,
        ownersCount: Object.keys(owners).length,
        dealsCount: deals.length,
        meetingsCount: meetings ? meetings.length : null,
        meetingsOk: meetingsError === null,
        meetingsError,
        dealActivitiesOk: dealActivitiesError === null,
        dealActivitiesError,
        pipelinesCount: pipelines.length,
        pipelinesOk: pipelinesError === null,
        pipelinesError,
        callsCount: calls ? calls.length : null,
        callsOk: callsError === null,
        callsError,
        emailsCount: emails ? emails.length : null,
        emailsOk: emailsError === null,
        emailsError,
        whatsappsCount: whatsapps ? whatsapps.length : null,
        whatsappsOk: whatsappsError === null,
        whatsappsError
      }
    };

    // Cache de borda da Vercel alinhado ao auto-refresh de 2 min. O
    // stale-while-revalidate longo faz a borda servir a resposta na hora
    // (instantânea) enquanto revalida o HubSpot em segundo plano — assim o
    // carregamento repetido não espera a busca completa na API. Quando o
    // pedido vem com ?fresh=1 (botão "Atualizar agora"), pulamos esse cache
    // para garantir uma busca de verdade no HubSpot a cada clique.
    if (forceFresh) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    }
    res.status(200).json({ available: true, status: { ok: true }, data });
  } catch (err) {
    res.status(200).json({
      available: false,
      status: { ok: false, error: String((err && err.message) || err) }
    });
  }
}

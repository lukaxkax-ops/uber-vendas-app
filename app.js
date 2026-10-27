// ============================================================================
// UberPro & Vendas — Controle Diário (PWA Local-First)
// ============================================================================

const STORAGE_KEY = 'uber_vendas_app_data_v1';
const CLOUD_OBJ_URL = 'https://api.restful-api.dev/objects/ff808181a09d98f701a17abda1b51d43';
const CLOUD_REALTIME_TOPIC = 'uber_vendas_sync_lukaxkax_d1cd189257';
const CLOUD_NTFY_URL = `https://ntfy.sh/${CLOUD_REALTIME_TOPIC}`;
const DEVICE_ID = 'dev_' + Math.random().toString(36).slice(2, 10);

const DEFAULT_PRODUCTS = [
  {
    id: 'prod_agua',
    emoji: '💧',
    name: 'Água Mineral 500ml',
    price: 4.00,
    cost: 1.10,
    stock: 12,
    minStock: 4
  },
  {
    id: 'prod_mentos',
    emoji: '🍬',
    name: 'Bala Mentos / Trident',
    price: 4.50,
    cost: 1.80,
    stock: 10,
    minStock: 3
  },
  {
    id: 'prod_choc',
    emoji: '🍫',
    name: 'Chocolate / Bombom',
    price: 5.00,
    cost: 2.20,
    stock: 8,
    minStock: 3
  },
  {
    id: 'prod_refri',
    emoji: '🥤',
    name: 'Refrigerante Lata',
    price: 6.00,
    cost: 2.70,
    stock: 6,
    minStock: 2
  }
];

// Estado global do aplicativo
let state = {
  selectedDate: getTodayISO(),
  activeTab: 'tab-corridas',
  historyPeriod: '7d',
  updatedAt: 0,
  products: [],
  days: {} // { 'YYYY-MM-DD': { earnings: 0, fuel: 0, km: 0, trips: 0, notes: '', sales: [] } }
};

let pushDebounceTimer = null;

// Utilitários de Data e Moeda
function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatBRL(value) {
  const num = Number(value) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatNumber(value, decimals = 1) {
  const num = Number(value) || 0;
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatFriendlyDate(isoDate) {
  const today = getTodayISO();
  if (isoDate === today) return 'Hoje';

  const [y, m, d] = isoDate.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const weekday = dateObj.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return `${d.toString().padStart(2, '0')}/${m.toString().padStart(2, '0')} (${weekday})`;
}

function isDefaultData(products, days) {
  const hasAnyDayActivity = Object.values(days || {}).some(
    (d) =>
      (Number(d.earnings) || 0) > 0 ||
      (Number(d.fuel) || 0) > 0 ||
      (Number(d.km) || 0) > 0 ||
      (Number(d.trips) || 0) > 0 ||
      (Array.isArray(d.sales) && d.sales.length > 0)
  );
  if (hasAnyDayActivity) return false;
  if (!Array.isArray(products) || products.length !== DEFAULT_PRODUCTS.length) return false;
  return products.every((p, idx) => {
    const def = DEFAULT_PRODUCTS[idx];
    return (
      p.id === def.id &&
      p.name === def.name &&
      Number(p.price) === Number(def.price) &&
      Number(p.cost) === Number(def.cost) &&
      Number(p.stock) === Number(def.stock)
    );
  });
}

// Persistência Local + Sincronização na Nuvem
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.products = [...DEFAULT_PRODUCTS];
      state.updatedAt = 0;
      saveStateLocalOnly();
      return;
    }
    const parsed = JSON.parse(raw);
    state.products = Array.isArray(parsed.products) ? parsed.products : [...DEFAULT_PRODUCTS];
    state.days = parsed.days && typeof parsed.days === 'object' ? parsed.days : {};

    if (typeof parsed.updatedAt === 'number') {
      state.updatedAt = parsed.updatedAt;
    } else {
      // Se o aparelho já tinha dados editados antes da atualização (ex: o estoque alterado no PC),
      // marca como mais recente para subir automaticamente para a nuvem!
      state.updatedAt = isDefaultData(state.products, state.days) ? 0 : Date.now();
      saveStateLocalOnly();
    }
  } catch (err) {
    console.error('Erro ao carregar dados locais:', err);
    state.products = [...DEFAULT_PRODUCTS];
    state.days = {};
    state.updatedAt = 0;
  }
}

function saveStateLocalOnly() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        updatedAt: state.updatedAt,
        products: state.products,
        days: state.days
      })
    );
  } catch (err) {
    console.error('Erro ao salvar dados locais:', err);
  }
}

function saveState() {
  state.updatedAt = Date.now();
  saveStateLocalOnly();
  schedulePushToCloud();
}

function setSyncStatusUI(status, label) {
  const btn = document.getElementById('btnCloudSync');
  const icon = document.getElementById('syncIcon');
  const text = document.getElementById('syncText');
  if (!btn || !icon || !text) return;

  btn.classList.remove('syncing', 'synced');
  if (status === 'syncing') {
    btn.classList.add('syncing');
    icon.textContent = '🔄';
    text.textContent = label || 'Sincronizando...';
  } else if (status === 'synced') {
    btn.classList.add('synced');
    icon.textContent = '☁️';
    text.textContent = label || 'Sincronizado';
  } else {
    icon.textContent = '⚠️';
    text.textContent = label || 'Offline';
  }
}

function schedulePushToCloud() {
  setSyncStatusUI('syncing', 'Salvando...');
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => {
    pushToCloud();
  }, 450);
}

async function pushToCloud() {
  setSyncStatusUI('syncing', 'Enviando...');
  const payload = {
    updatedAt: state.updatedAt || Date.now(),
    deviceId: DEVICE_ID,
    products: state.products,
    days: state.days
  };

  let ok = false;

  // 1) Envia em tempo real via ntfy (atualiza outros aparelhos abertos na hora e guarda em cache)
  try {
    const resNtfy = await fetch(CLOUD_NTFY_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (resNtfy.ok) ok = true;
  } catch (e) {
    console.warn('Falha ao publicar no canal realtime:', e);
  }

  // 2) Salva no banco permanente restful-api.dev
  try {
    const resObj = await fetch(CLOUD_OBJ_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'uber-vendas-sync',
        data: payload
      })
    });
    if (resObj.ok) ok = true;
  } catch (e) {
    console.warn('Falha ao salvar no banco permanente:', e);
  }

  if (ok) {
    setSyncStatusUI('synced', 'Sincronizado');
  } else {
    setSyncStatusUI('error', 'Salvo local');
  }
}

function applyRemotePayloadIfNewer(remoteData, notifyUser = false) {
  if (!remoteData || typeof remoteData !== 'object') return false;
  const remoteUpdated = Number(remoteData.updatedAt) || 0;
  if (remoteUpdated <= 0) return false;

  if (remoteUpdated > (Number(state.updatedAt) || 0)) {
    state.updatedAt = remoteUpdated;
    if (Array.isArray(remoteData.products)) {
      state.products = remoteData.products;
    }
    if (remoteData.days && typeof remoteData.days === 'object') {
      state.days = remoteData.days;
    }
    saveStateLocalOnly();
    renderAll();
    setSyncStatusUI('synced', 'Sincronizado');
    if (notifyUser) {
      showToast('☁️ Dados atualizados da nuvem!');
    }
    return true;
  }
  return false;
}

async function syncFromCloud(manualClick = false) {
  setSyncStatusUI('syncing', 'Sincronizando...');
  let bestRemote = null;

  // Busca em paralelo do canal realtime (ntfy) e do banco permanente (restful-api)
  const [ntfyResult, objResult] = await Promise.allSettled([
    fetch(`${CLOUD_NTFY_URL}/json?poll=1&since=12h`, { cache: 'no-store' }).then((r) =>
      r.ok ? r.text() : ''
    ),
    fetch(CLOUD_OBJ_URL, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
  ]);

  if (ntfyResult.status === 'fulfilled' && ntfyResult.value) {
    const lines = ntfyResult.value.trim().split('\n');
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'message' && evt.message) {
          const parsedMsg = JSON.parse(evt.message);
          if (
            parsedMsg &&
            typeof parsedMsg.updatedAt === 'number' &&
            (!bestRemote || parsedMsg.updatedAt > bestRemote.updatedAt)
          ) {
            bestRemote = parsedMsg;
          }
        }
      } catch (_) {}
    }
  }

  if (objResult.status === 'fulfilled' && objResult.value?.data) {
    const objData = objResult.value.data;
    if (
      objData &&
      typeof objData.updatedAt === 'number' &&
      (!bestRemote || objData.updatedAt > bestRemote.updatedAt)
    ) {
      bestRemote = objData;
    }
  }

  const remoteUpdated = Number(bestRemote?.updatedAt) || 0;
  const localUpdated = Number(state.updatedAt) || 0;

  if (remoteUpdated > localUpdated) {
    applyRemotePayloadIfNewer(bestRemote, manualClick);
  } else if (localUpdated > remoteUpdated) {
    // O aparelho atual tem dados mais novos (ex: estoque que você acabou de editar no PC!)
    await pushToCloud();
    if (manualClick) {
      showToast('☁️ Dados deste aparelho enviados para a nuvem!');
    }
  } else {
    setSyncStatusUI('synced', 'Sincronizado');
    if (manualClick) {
      showToast('☁️ Tudo já está sincronizado!');
    }
  }
}

function startRealtimeSyncListener() {
  if (typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource(`${CLOUD_NTFY_URL}/sse`);
    es.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data);
        if (evt.message) {
          const remoteData = JSON.parse(evt.message);
          if (remoteData.deviceId !== DEVICE_ID) {
            applyRemotePayloadIfNewer(remoteData, true);
          }
        }
      } catch (_) {}
    };
  } catch (e) {
    console.warn('SSE indisponível:', e);
  }
}

function getDayRecord(isoDate) {
  if (!state.days[isoDate]) {
    state.days[isoDate] = {
      earnings: 0,
      fuel: 0,
      km: 0,
      trips: 0,
      notes: '',
      sales: []
    };
  }
  return state.days[isoDate];
}

function calcDaySummary(dayRecord) {
  const earnings = Number(dayRecord?.earnings) || 0;
  const fuel = Number(dayRecord?.fuel) || 0;
  const km = Number(dayRecord?.km) || 0;
  const trips = Number(dayRecord?.trips) || 0;
  const sales = Array.isArray(dayRecord?.sales) ? dayRecord.sales : [];

  const uberNet = earnings - fuel;
  const salesGross = sales.reduce((acc, s) => acc + (Number(s.price) || 0), 0);
  const salesCost = sales.reduce((acc, s) => acc + (Number(s.cost) || 0), 0);
  const salesNet = salesGross - salesCost;

  const totalGross = earnings + salesGross;
  const totalNet = uberNet + salesNet;

  return {
    earnings,
    fuel,
    km,
    trips,
    uberNet,
    salesCount: sales.length,
    salesGross,
    salesCost,
    salesNet,
    totalGross,
    totalNet
  };
}

// ============================================================================
// Renderização da Interface
// ============================================================================

function renderAll() {
  renderDateHeader();
  renderHeroAndLowStock();
  renderUberTab();
  renderSalesTab();
  renderInventoryTab();
  renderHistoryTab();
}

function renderDateHeader() {
  const dateInput = document.getElementById('selectedDate');
  const dateLabel = document.getElementById('dateFormattedLabel');
  dateInput.value = state.selectedDate;
  dateLabel.textContent = formatFriendlyDate(state.selectedDate);
}

function renderHeroAndLowStock() {
  const day = getDayRecord(state.selectedDate);
  const summary = calcDaySummary(day);

  const totalNetEl = document.getElementById('heroTotalNetProfit');
  totalNetEl.textContent = formatBRL(summary.totalNet);
  totalNetEl.style.color = summary.totalNet < 0 ? '#fca5a5' : '#ffffff';

  document.getElementById('heroGrossRevenue').textContent =
    `Faturamento bruto total: ${formatBRL(summary.totalGross)}`;

  document.getElementById('heroUberNet').textContent = formatBRL(summary.uberNet);
  document.getElementById('heroUberDetail').textContent =
    `Bruto: ${formatBRL(summary.earnings)} | Comb.: ${formatBRL(summary.fuel)}`;

  document.getElementById('heroSalesNet').textContent = formatBRL(summary.salesNet);
  document.getElementById('heroSalesDetail').textContent =
    `Vendido: ${formatBRL(summary.salesGross)} (${summary.salesCount} ${summary.salesCount === 1 ? 'item' : 'itens'})`;

  // Verifica estoque baixo
  const lowStockItems = state.products.filter((p) => p.stock <= (p.minStock ?? 3));
  const banner = document.getElementById('lowStockBanner');
  const navBadge = document.getElementById('navStockBadge');

  if (lowStockItems.length > 0) {
    banner.classList.remove('hidden');
    navBadge.classList.remove('hidden');
    navBadge.textContent = lowStockItems.length;
    const names = lowStockItems.map((i) => `${i.emoji} ${i.name} (${i.stock})`).join(', ');
    document.getElementById('lowStockBannerText').textContent = `Estoque baixo: ${names}`;
  } else {
    banner.classList.add('hidden');
    navBadge.classList.add('hidden');
  }
}

function renderUberTab() {
  const day = getDayRecord(state.selectedDate);
  const summary = calcDaySummary(day);

  const earningsInput = document.getElementById('uberEarnings');
  const fuelInput = document.getElementById('uberFuel');
  const kmInput = document.getElementById('uberKm');
  const tripsInput = document.getElementById('uberTrips');
  const notesInput = document.getElementById('uberNotes');

  if (document.activeElement !== earningsInput) {
    earningsInput.value = day.earnings ? day.earnings : '';
  }
  if (document.activeElement !== fuelInput) {
    fuelInput.value = day.fuel ? day.fuel : '';
  }
  if (document.activeElement !== kmInput) {
    kmInput.value = day.km ? day.km : '';
  }
  if (document.activeElement !== tripsInput) {
    tripsInput.value = day.trips ? day.trips : '';
  }
  if (document.activeElement !== notesInput) {
    notesInput.value = day.notes || '';
  }

  // Métricas calculadas
  document.getElementById('metricUberProfit').textContent = formatBRL(summary.uberNet);

  const grossPerKm = summary.km > 0 ? summary.earnings / summary.km : 0;
  const netPerKm = summary.km > 0 ? summary.uberNet / summary.km : 0;
  document.getElementById('metricPerKm').textContent = `${formatBRL(grossPerKm)}/km`;
  document.getElementById('metricNetPerKm').textContent = `Líquido: ${formatBRL(netPerKm)}/km`;

  const avgPerTrip = summary.trips > 0 ? summary.earnings / summary.trips : 0;
  const kmPerTrip = summary.trips > 0 ? summary.km / summary.trips : 0;
  document.getElementById('metricPerTrip').textContent = formatBRL(avgPerTrip);
  document.getElementById('metricKmPerTrip').textContent = `${formatNumber(kmPerTrip, 1)} km / corrida`;

  const fuelPerKm = summary.km > 0 ? summary.fuel / summary.km : 0;
  const fuelPct = summary.earnings > 0 ? (summary.fuel / summary.earnings) * 100 : 0;
  document.getElementById('metricFuelPerKm').textContent = `${formatBRL(fuelPerKm)}/km`;
  document.getElementById('metricFuelPct').textContent = `${formatNumber(fuelPct, 0)}% dos ganhos`;
}

function renderSalesTab() {
  const day = getDayRecord(state.selectedDate);
  const summary = calcDaySummary(day);

  document.getElementById('salesDayGross').textContent = formatBRL(summary.salesGross);
  document.getElementById('salesDayCost').textContent = formatBRL(summary.salesCost);
  document.getElementById('salesDayProfit').textContent = formatBRL(summary.salesNet);
  document.getElementById('salesCountBadge').textContent = summary.salesCount;

  const undoBtn = document.getElementById('btnUndoLastSale');
  if (day.sales.length > 0) {
    undoBtn.classList.remove('hidden');
  } else {
    undoBtn.classList.add('hidden');
  }

  // Grid de botões de venda rápida
  const grid = document.getElementById('quickSaleGrid');
  if (state.products.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        Nenhum item cadastrado ainda. Vá na aba <strong>Estoque</strong> para cadastrar seus produtos!
      </div>
    `;
  } else {
    grid.innerHTML = state.products
      .map((prod) => {
        const profit = prod.price - prod.cost;
        const isOut = prod.stock <= 0;
        const isLow = !isOut && prod.stock <= (prod.minStock ?? 3);
        const stockClass = isOut ? 'out' : isLow ? 'low' : '';
        const stockText = isOut ? 'Sem estoque' : `${prod.stock} disp.`;

        return `
          <button
            type="button"
            class="sale-item-btn"
            data-sell-id="${prod.id}"
            ${isOut ? 'disabled' : ''}
          >
            <div class="sale-btn-top">
              <span class="sale-emoji">${prod.emoji || '📦'}</span>
              <span class="stock-pill ${stockClass}">${stockText}</span>
            </div>
            <div class="sale-name">${escapeHtml(prod.name)}</div>
            <div class="sale-btn-bottom">
              <span class="sale-price">${formatBRL(prod.price)}</span>
              <span class="sale-profit-tag">+${formatBRL(profit)} lucro</span>
            </div>
          </button>
        `;
      })
      .join('');
  }

  // Lista de vendas registradas no dia
  const logContainer = document.getElementById('dailySalesLog');
  if (day.sales.length === 0) {
    logContainer.innerHTML = `
      <div class="empty-state">
        Nenhuma venda registrada em ${formatFriendlyDate(state.selectedDate)}. Toque em um item acima quando vender!
      </div>
    `;
  } else {
    const reversedSales = [...day.sales].reverse();
    logContainer.innerHTML = reversedSales
      .map((sale) => {
        const profit = (Number(sale.price) || 0) - (Number(sale.cost) || 0);
        return `
          <div class="log-item">
            <div class="log-info">
              <span class="sale-emoji">${sale.emoji || '📦'}</span>
              <div>
                <div class="log-title">${escapeHtml(sale.name)}</div>
                <div class="log-meta">Às ${sale.time || '--:--'} • Custo: ${formatBRL(sale.cost)}</div>
              </div>
            </div>
            <div class="log-right">
              <div class="log-values">
                <span class="log-price">${formatBRL(sale.price)}</span>
                <span class="log-profit">+${formatBRL(profit)} lucro</span>
              </div>
              <button
                type="button"
                class="btn-delete-sm"
                data-refund-sale-id="${sale.saleId}"
                title="Estornar venda e devolver ao estoque"
              >
                Estornar
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

function renderInventoryTab() {
  // Resumo do estoque
  let totalUnits = 0;
  let totalCost = 0;
  let potentialProfit = 0;

  state.products.forEach((p) => {
    const qty = Math.max(0, Number(p.stock) || 0);
    totalUnits += qty;
    totalCost += qty * (Number(p.cost) || 0);
    potentialProfit += qty * ((Number(p.price) || 0) - (Number(p.cost) || 0));
  });

  document.getElementById('stockTotalUnits').textContent = `${totalUnits} un.`;
  document.getElementById('stockTotalCost').textContent = formatBRL(totalCost);
  document.getElementById('stockPotentialProfit').textContent = formatBRL(potentialProfit);

  const list = document.getElementById('inventoryList');
  if (state.products.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        Seu estoque está vazio. Cadastre seus itens no formulário acima ou clique em "Carregar Exemplos".
      </div>
    `;
    return;
  }

  list.innerHTML = state.products
    .map((prod) => {
      const unitProfit = (Number(prod.price) || 0) - (Number(prod.cost) || 0);
      const isOut = prod.stock <= 0;
      const isLow = !isOut && prod.stock <= (prod.minStock ?? 3);
      const cardAlertClass = isOut ? 'out-of-stock' : isLow ? 'low-stock' : '';
      const pillClass = isOut ? 'out' : isLow ? 'low' : '';
      const stockStatus = isOut
        ? 'ESGOTADO (0 un.)'
        : isLow
        ? `ESTOQUE BAIXO (${prod.stock} un.)`
        : `${prod.stock} em estoque`;

      return `
        <div class="inv-card ${cardAlertClass}">
          <div class="inv-top">
            <div class="inv-title-group">
              <span class="inv-emoji">${prod.emoji || '📦'}</span>
              <div>
                <div class="inv-name">${escapeHtml(prod.name)}</div>
                <div class="inv-prices">
                  Venda: <strong>${formatBRL(prod.price)}</strong> •
                  Custo: ${formatBRL(prod.cost)} •
                  <span class="text-emerald">Lucro: ${formatBRL(unitProfit)}/un</span>
                </div>
              </div>
            </div>
            <span class="stock-pill ${pillClass}">${stockStatus}</span>
          </div>

          <div class="inv-bottom">
            <div class="stock-quick-btns">
              <button type="button" class="stock-adj-btn" data-stock-id="${prod.id}" data-delta="-1">−1</button>
              <button type="button" class="stock-adj-btn" data-stock-id="${prod.id}" data-delta="1">+1</button>
              <button type="button" class="stock-adj-btn" data-stock-id="${prod.id}" data-delta="6">+6</button>
              <button type="button" class="stock-adj-btn" data-stock-id="${prod.id}" data-delta="12">+12</button>
            </div>
            <div class="inv-actions">
              <button type="button" class="btn-icon-action" data-edit-id="${prod.id}">✏️ Editar</button>
              <button type="button" class="btn-icon-action" data-delete-id="${prod.id}">🗑️</button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderHistoryTab() {
  const todayISO = getTodayISO();
  const [ty, tm, td] = todayISO.split('-').map(Number);
  const todayObj = new Date(ty, tm - 1, td);

  const allDates = Object.keys(state.days).sort((a, b) => b.localeCompare(a));

  const filteredDates = allDates.filter((iso) => {
    const d = state.days[iso];
    const hasActivity =
      (Number(d.earnings) || 0) > 0 ||
      (Number(d.fuel) || 0) > 0 ||
      (Number(d.km) || 0) > 0 ||
      (Number(d.trips) || 0) > 0 ||
      (Array.isArray(d.sales) && d.sales.length > 0);
    if (!hasActivity) return false;

    if (state.historyPeriod === 'all') return true;
    if (state.historyPeriod === 'month') {
      return iso.startsWith(`${ty}-${String(tm).padStart(2, '0')}`);
    }
    if (state.historyPeriod === '7d') {
      const [y, m, dayNum] = iso.split('-').map(Number);
      const dateObj = new Date(y, m - 1, dayNum);
      const diffDays = (todayObj - dateObj) / (1000 * 60 * 60 * 24);
      return diffDays >= 0 && diffDays <= 6;
    }
    return true;
  });

  let totalNet = 0;
  let totalGross = 0;
  let uberNet = 0;
  let fuelTotal = 0;
  let salesNet = 0;
  let salesCount = 0;
  let totalKm = 0;
  let totalTrips = 0;

  const productStats = {};

  filteredDates.forEach((iso) => {
    const rec = state.days[iso];
    const sum = calcDaySummary(rec);
    totalNet += sum.totalNet;
    totalGross += sum.totalGross;
    uberNet += sum.uberNet;
    fuelTotal += sum.fuel;
    salesNet += sum.salesNet;
    salesCount += sum.salesCount;
    totalKm += sum.km;
    totalTrips += sum.trips;

    (rec.sales || []).forEach((s) => {
      const key = s.name;
      if (!productStats[key]) {
        productStats[key] = {
          name: s.name,
          emoji: s.emoji || '📦',
          qty: 0,
          revenue: 0,
          profit: 0
        };
      }
      productStats[key].qty += 1;
      productStats[key].revenue += Number(s.price) || 0;
      productStats[key].profit += (Number(s.price) || 0) - (Number(s.cost) || 0);
    });
  });

  document.getElementById('histTotalNet').textContent = formatBRL(totalNet);
  document.getElementById('histGrossTotal').textContent = `Bruto: ${formatBRL(totalGross)}`;
  document.getElementById('histUberNet').textContent = formatBRL(uberNet);
  document.getElementById('histFuelTotal').textContent = `Combustível: ${formatBRL(fuelTotal)}`;
  document.getElementById('histSalesNet').textContent = formatBRL(salesNet);
  document.getElementById('histSalesCount').textContent = `${salesCount} itens vendidos`;
  document.getElementById('histTotalKm').textContent = `${formatNumber(totalKm, 1)} km`;
  document.getElementById('histTotalTrips').textContent = `${totalTrips} corridas realizadas`;

  // Top produtos no período
  const topProductsEl = document.getElementById('topProductsList');
  const rankedProducts = Object.values(productStats).sort((a, b) => b.profit - a.profit);

  if (rankedProducts.length === 0) {
    topProductsEl.innerHTML = `<div class="empty-state">Nenhuma venda registrada neste período.</div>`;
  } else {
    topProductsEl.innerHTML = rankedProducts
      .map(
        (item) => `
        <div class="log-item">
          <div class="log-info">
            <span class="sale-emoji">${item.emoji}</span>
            <div>
              <div class="log-title">${escapeHtml(item.name)}</div>
              <div class="log-meta">${item.qty} ${item.qty === 1 ? 'unidade vendida' : 'unidades vendidas'}</div>
            </div>
          </div>
          <div class="log-values">
            <span class="log-price">${formatBRL(item.revenue)}</span>
            <span class="log-profit">+${formatBRL(item.profit)} lucro</span>
          </div>
        </div>
      `
      )
      .join('');
  }

  // Lista de dias registrados
  const daysListEl = document.getElementById('historyDaysList');
  if (filteredDates.length === 0) {
    daysListEl.innerHTML = `<div class="empty-state">Nenhum registro encontrado neste período.</div>`;
  } else {
    daysListEl.innerHTML = filteredDates
      .map((iso) => {
        const sum = calcDaySummary(state.days[iso]);
        return `
          <div class="history-day-row" data-open-date="${iso}">
            <div>
              <div class="log-title">📅 ${formatFriendlyDate(iso)} <small style="color:var(--text-muted)">(${iso.split('-').reverse().join('/')})</small></div>
              <div class="log-meta">
                🚗 Uber Líq: ${formatBRL(sum.uberNet)} (${sum.trips} corr. / ${formatNumber(sum.km, 0)}km) •
                🍫 Vendas Líq: ${formatBRL(sum.salesNet)} (${sum.salesCount})
              </div>
            </div>
            <div class="log-values">
              <span class="log-price text-emerald">${formatBRL(sum.totalNet)}</span>
              <span class="log-meta">Lucro Total</span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

// ============================================================================
// Ações do Usuário
// ============================================================================

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === tabId);
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Mostra o card de resumo geral nas abas de Corridas e Vender
  const hero = document.getElementById('dailyHeroSummary');
  if (tabId === 'tab-corridas' || tabId === 'tab-vendas') {
    hero.classList.remove('hidden');
  } else {
    hero.classList.add('hidden');
  }
  renderAll();
}

function changeSelectedDate(newDateISO) {
  if (!newDateISO) return;
  state.selectedDate = newDateISO;
  renderAll();
}

function shiftDate(daysDelta) {
  const [y, m, d] = state.selectedDate.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  dateObj.setDate(dateObj.getDate() + daysDelta);
  const ny = dateObj.getFullYear();
  const nm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const nd = String(dateObj.getDate()).padStart(2, '0');
  changeSelectedDate(`${ny}-${nm}-${nd}`);
}

function registerQuickSale(productId) {
  const prod = state.products.find((p) => p.id === productId);
  if (!prod) return;

  if (prod.stock <= 0) {
    showToast(`⚠️ "${prod.name}" está sem estoque!`);
    return;
  }

  prod.stock -= 1;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const saleEntry = {
    saleId: 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    productId: prod.id,
    name: prod.name,
    emoji: prod.emoji || '📦',
    price: Number(prod.price) || 0,
    cost: Number(prod.cost) || 0,
    time: timeStr
  };

  const day = getDayRecord(state.selectedDate);
  day.sales.push(saleEntry);

  saveState();
  renderAll();

  const profit = saleEntry.price - saleEntry.cost;
  showToast(
    `✅ Venda: ${prod.emoji} ${prod.name} (+${formatBRL(profit)} lucro)`,
    'Desfazer',
    () => refundSale(saleEntry.saleId)
  );
}

function refundSale(saleId) {
  const day = getDayRecord(state.selectedDate);
  const idx = day.sales.findIndex((s) => s.saleId === saleId);
  if (idx === -1) return;

  const [removed] = day.sales.splice(idx, 1);
  const prod = state.products.find((p) => p.id === removed.productId);
  if (prod) {
    prod.stock += 1;
  }

  saveState();
  renderAll();
  showToast(`↩ Venda de "${removed.name}" estornada e devolvida ao estoque.`);
}

function showToast(message, actionLabel = null, actionCallback = null) {
  const container = document.getElementById('toastContainer');
  container.innerHTML = '';

  const toast = document.createElement('div');
  toast.className = 'toast';

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (actionLabel && typeof actionCallback === 'function') {
    const btn = document.createElement('button');
    btn.className = 'banner-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      actionCallback();
      toast.remove();
    });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4000);
}

function flashSavedBadge() {
  const badge = document.getElementById('saveStatusIndicator');
  if (!badge) return;
  badge.textContent = '✓ Salvo agora';
  setTimeout(() => {
    badge.textContent = 'Salvo';
  }, 1500);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Eventos e Inicialização
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  renderAll();
  syncFromCloud(false);
  startRealtimeSyncListener();

  // Sincroniza sempre que voltar para a aba/app no celular ou PC
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncFromCloud(false);
    }
  });
  window.addEventListener('focus', () => syncFromCloud(false));

  // Botão de sincronização no topo
  const btnCloudSync = document.getElementById('btnCloudSync');
  if (btnCloudSync) {
    btnCloudSync.addEventListener('click', () => syncFromCloud(true));
  }

  // Botão para forçar envio dos dados deste aparelho (ex: estoque do PC) para a nuvem
  const btnForcePush = document.getElementById('btnForcePushCloud');
  if (btnForcePush) {
    btnForcePush.addEventListener('click', async () => {
      state.updatedAt = Date.now();
      saveStateLocalOnly();
      await pushToCloud();
      showToast('☁️ Estoque e dados deste aparelho enviados para o celular/PC!');
    });
  }

  // Registro opcional de Service Worker (PWA)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').then((reg) => reg.update()).catch(() => {});
  }

  // Navegação de abas
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.gotoTab));
  });

  // Navegação de datas
  document.getElementById('selectedDate').addEventListener('change', (e) => {
    changeSelectedDate(e.target.value);
  });
  document.getElementById('btnPrevDay').addEventListener('click', () => shiftDate(-1));
  document.getElementById('btnNextDay').addEventListener('click', () => shiftDate(1));
  document.getElementById('btnToday').addEventListener('click', () => {
    changeSelectedDate(getTodayISO());
  });

  // Inputs da Aba 1 (Corridas)
  const uberFields = [
    { id: 'uberEarnings', key: 'earnings', isFloat: true },
    { id: 'uberFuel', key: 'fuel', isFloat: true },
    { id: 'uberKm', key: 'km', isFloat: true },
    { id: 'uberTrips', key: 'trips', isFloat: false },
    { id: 'uberNotes', key: 'notes', isString: true }
  ];

  uberFields.forEach(({ id, key, isFloat, isString }) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const day = getDayRecord(state.selectedDate);
      if (isString) {
        day[key] = el.value;
      } else {
        const val = isFloat ? parseFloat(el.value) : parseInt(el.value, 10);
        day[key] = isNaN(val) || val < 0 ? 0 : val;
      }
      saveState();
      flashSavedBadge();
      renderHeroAndLowStock();
      renderUberTab();
    });
  });

  // Botões de adição rápida (+R$ 15, +R$ 50, +10km, etc.)
  document.querySelectorAll('[data-add-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fieldId = btn.dataset.addField;
      const amount = parseFloat(btn.dataset.amount) || 0;
      const inputEl = document.getElementById(fieldId);
      const currentVal = parseFloat(inputEl.value) || 0;
      const nextVal = Math.round((currentVal + amount) * 100) / 100;
      inputEl.value = nextVal;
      inputEl.dispatchEvent(new Event('input'));
    });
  });

  // Stepper de número de corridas (- / +)
  document.getElementById('btnDecrementTrip').addEventListener('click', () => {
    const day = getDayRecord(state.selectedDate);
    day.trips = Math.max(0, (Number(day.trips) || 0) - 1);
    document.getElementById('uberTrips').value = day.trips || '';
    saveState();
    flashSavedBadge();
    renderAll();
  });

  document.getElementById('btnIncrementTrip').addEventListener('click', () => {
    const day = getDayRecord(state.selectedDate);
    day.trips = (Number(day.trips) || 0) + 1;
    document.getElementById('uberTrips').value = day.trips;
    saveState();
    flashSavedBadge();
    renderAll();
  });

  // Delegação de cliques na Aba 2 (Vendas Rápidas)
  document.getElementById('quickSaleGrid').addEventListener('click', (e) => {
    const sellBtn = e.target.closest('[data-sell-id]');
    if (sellBtn) {
      registerQuickSale(sellBtn.dataset.sellId);
    }
  });

  document.getElementById('btnUndoLastSale').addEventListener('click', () => {
    const day = getDayRecord(state.selectedDate);
    if (day.sales.length > 0) {
      const lastSale = day.sales[day.sales.length - 1];
      refundSale(lastSale.saleId);
    }
  });

  document.getElementById('dailySalesLog').addEventListener('click', (e) => {
    const refundBtn = e.target.closest('[data-refund-sale-id]');
    if (refundBtn) {
      refundSale(refundBtn.dataset.refundSaleId);
    }
  });

  // Formulário de Produto na Aba 3 (Estoque)
  const priceInput = document.getElementById('productPrice');
  const costInput = document.getElementById('productCost');
  const updateMarginPreview = () => {
    const price = parseFloat(priceInput.value) || 0;
    const cost = parseFloat(costInput.value) || 0;
    const profit = price - cost;
    const margin = price > 0 ? (profit / price) * 100 : 0;
    document.getElementById('marginPreview').innerHTML = `
      Lucro por unidade: <strong>${formatBRL(profit)}</strong> (${formatNumber(margin, 0)}% de margem)
    `;
  };
  priceInput.addEventListener('input', updateMarginPreview);
  costInput.addEventListener('input', updateMarginPreview);

  const productForm = document.getElementById('productForm');
  const cancelEditBtn = document.getElementById('btnCancelEditProduct');

  const resetProductForm = () => {
    productForm.reset();
    document.getElementById('productId').value = '';
    document.getElementById('productMinStock').value = '3';
    document.getElementById('productFormTitle').textContent = '➕ Cadastrar Novo Item';
    document.getElementById('btnSaveProduct').textContent = 'Salvar Item no Estoque';
    cancelEditBtn.classList.add('hidden');
    updateMarginPreview();
  };

  cancelEditBtn.addEventListener('click', resetProductForm);

  productForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('productId').value;
    const emoji = document.getElementById('productEmoji').value;
    const name = document.getElementById('productName').value.trim();
    const price = parseFloat(document.getElementById('productPrice').value) || 0;
    const cost = parseFloat(document.getElementById('productCost').value) || 0;
    const stock = parseInt(document.getElementById('productStock').value, 10) || 0;
    const minStock = parseInt(document.getElementById('productMinStock').value, 10) || 0;

    if (!name) return;

    if (id) {
      const existing = state.products.find((p) => p.id === id);
      if (existing) {
        existing.emoji = emoji;
        existing.name = name;
        existing.price = price;
        existing.cost = cost;
        existing.stock = Math.max(0, stock);
        existing.minStock = Math.max(0, minStock);
      }
      showToast(`✅ Item "${name}" atualizado!`);
    } else {
      state.products.push({
        id: 'prod_' + Date.now(),
        emoji,
        name,
        price,
        cost,
        stock: Math.max(0, stock),
        minStock: Math.max(0, minStock)
      });
      showToast(`✅ Item "${name}" cadastrado no estoque!`);
    }

    saveState();
    resetProductForm();
    renderAll();
  });

  document.getElementById('btnLoadSamples').addEventListener('click', () => {
    DEFAULT_PRODUCTS.forEach((sample) => {
      if (!state.products.some((p) => p.name.toLowerCase() === sample.name.toLowerCase())) {
        state.products.push({ ...sample, id: 'prod_' + Date.now() + Math.random().toString(36).slice(2, 5) });
      }
    });
    saveState();
    renderAll();
    showToast('📦 Itens de exemplo adicionados ao estoque!');
  });

  // Ações nos cards de estoque (ajustar quantidade, editar, excluir)
  document.getElementById('inventoryList').addEventListener('click', (e) => {
    const stockBtn = e.target.closest('[data-stock-id]');
    if (stockBtn) {
      const prod = state.products.find((p) => p.id === stockBtn.dataset.stockId);
      const delta = parseInt(stockBtn.dataset.delta, 10) || 0;
      if (prod) {
        prod.stock = Math.max(0, (Number(prod.stock) || 0) + delta);
        saveState();
        renderAll();
      }
      return;
    }

    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      const prod = state.products.find((p) => p.id === editBtn.dataset.editId);
      if (prod) {
        document.getElementById('productId').value = prod.id;
        document.getElementById('productEmoji').value = prod.emoji || '📦';
        document.getElementById('productName').value = prod.name;
        document.getElementById('productPrice').value = prod.price;
        document.getElementById('productCost').value = prod.cost;
        document.getElementById('productStock').value = prod.stock;
        document.getElementById('productMinStock').value = prod.minStock ?? 3;
        document.getElementById('productFormTitle').textContent = `✏️ Editando: ${prod.name}`;
        document.getElementById('btnSaveProduct').textContent = 'Atualizar Item';
        cancelEditBtn.classList.remove('hidden');
        updateMarginPreview();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      const prod = state.products.find((p) => p.id === deleteBtn.dataset.deleteId);
      if (prod && confirm(`Deseja remover "${prod.name}" da sua lista de itens?`)) {
        state.products = state.products.filter((p) => p.id !== prod.id);
        saveState();
        renderAll();
        showToast(`🗑️ Item "${prod.name}" removido.`);
      }
    }
  });

  // Filtros do Histórico (Aba 4)
  document.querySelectorAll('.period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.historyPeriod = btn.dataset.period;
      renderHistoryTab();
    });
  });

  document.getElementById('historyDaysList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-open-date]');
    if (row) {
      changeSelectedDate(row.dataset.openDate);
      switchTab('tab-corridas');
      showToast(`📅 Exibindo dados de ${formatFriendlyDate(row.dataset.openDate)}`);
    }
  });

  // Exportar e Importar Backup JSON
  document.getElementById('btnExportData').addEventListener('click', () => {
    const dataStr = JSON.stringify({ products: state.products, days: state.days }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-uber-vendas-${getTodayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('💾 Backup exportado com sucesso!');
  });

  document.getElementById('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (Array.isArray(imported.products) && typeof imported.days === 'object') {
          state.products = imported.products;
          state.days = imported.days;
          saveState();
          renderAll();
          showToast('✅ Backup restaurado com sucesso!');
        } else {
          alert('Arquivo de backup inválido.');
        }
      } catch (err) {
        alert('Erro ao ler o arquivo de backup.');
      }
    };
    reader.readAsText(file);
  });
});

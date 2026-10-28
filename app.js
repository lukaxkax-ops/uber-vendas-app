// ============================================================================
// UberPro & Vendas — Controle Diário (Perfis: Lucas & Bianca + Sincronização Nuvem)
// ============================================================================

const STORAGE_KEY = 'uber_vendas_app_data_v1';
const ACTIVE_PROFILE_KEY = 'uber_vendas_active_profile_v1';
const TIMER_STORAGE_PREFIX = 'uber_vendas_timer_';

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

function cloneDefaultProducts() {
  return DEFAULT_PRODUCTS.map((p) => ({ ...p }));
}

// Estado global do aplicativo
let state = {
  activeProfile: localStorage.getItem(ACTIVE_PROFILE_KEY) || 'lucas', // 'lucas' | 'bianca'
  selectedDate: getTodayISO(),
  activeTab: 'tab-corridas',
  historyPeriod: '7d',
  updatedAt: 0,
  profiles: {
    lucas: {
      products: cloneDefaultProducts(),
      days: {}
    },
    bianca: {
      products: cloneDefaultProducts(),
      days: {}
    }
  }
};

let pushDebounceTimer = null;
let stopwatchInterval = null;

// ============================================================================
// Utilitários de Data, Hora, Cronômetro e Moeda
// ============================================================================

function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getCurrentTimeHHMM() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
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

function formatSecondsToHHMMSS(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatSecondsToShortHM(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0 && sec > 0) return `${sec}s`;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

function parseHHMMSSToSeconds(str) {
  if (!str) return 0;
  const clean = String(str).trim();
  const parts = clean.split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 3600 + parts[1] * 60;
  }
  if (parts.length === 1) {
    return parts[0] * 60;
  }
  return 0;
}

// ============================================================================
// Acesso ao Perfil Ativo (Lucas ou Bianca) e Normalização de Dados
// ============================================================================

function getProfileData(profileKey = state.activeProfile) {
  const key = profileKey === 'bianca' ? 'bianca' : 'lucas';
  if (!state.profiles[key]) {
    state.profiles[key] = {
      products: cloneDefaultProducts(),
      days: {}
    };
  }
  if (!Array.isArray(state.profiles[key].products)) {
    state.profiles[key].products = cloneDefaultProducts();
  }
  if (!state.profiles[key].days || typeof state.profiles[key].days !== 'object') {
    state.profiles[key].days = {};
  }
  return state.profiles[key];
}

function getProfileDisplayName(profileKey = state.activeProfile) {
  return profileKey === 'bianca' ? 'Bianca' : 'Lucas';
}

function normalizeDayRecord(dayObj) {
  if (!dayObj || typeof dayObj !== 'object') {
    return { sessions: [], sales: [] };
  }
  if (!Array.isArray(dayObj.sales)) {
    dayObj.sales = [];
  }
  if (!Array.isArray(dayObj.sessions)) {
    dayObj.sessions = [];
    // Migração automática caso existam dados antigos salvos diretamente no dia
    const legacyEarnings = Number(dayObj.earnings) || 0;
    const legacyFuel = Number(dayObj.fuel) || 0;
    const legacyKm = Number(dayObj.km) || 0;
    const legacyTrips = Number(dayObj.trips) || 0;
    const legacyNotes = dayObj.notes || '';

    if (legacyEarnings > 0 || legacyFuel > 0 || legacyKm > 0 || legacyTrips > 0 || legacyNotes) {
      dayObj.sessions.push({
        sessionId: 'sess_legacy_' + Math.random().toString(36).slice(2, 7),
        time: '08:00',
        car: 'Onix',
        earnings: legacyEarnings,
        fuel: legacyFuel,
        fuelPrice: 0,
        km: legacyKm,
        trips: legacyTrips,
        durationSeconds: 0,
        durationText: '00:00:00',
        notes: legacyNotes
      });
      delete dayObj.earnings;
      delete dayObj.fuel;
      delete dayObj.km;
      delete dayObj.trips;
      delete dayObj.notes;
    }
  }
  return dayObj;
}

function normalizeProfileStructure(profileObj) {
  if (!profileObj || typeof profileObj !== 'object') {
    return { products: cloneDefaultProducts(), days: {} };
  }
  const products = Array.isArray(profileObj.products)
    ? profileObj.products
    : cloneDefaultProducts();
  const rawDays = profileObj.days && typeof profileObj.days === 'object' ? profileObj.days : {};
  const days = {};
  for (const [iso, d] of Object.entries(rawDays)) {
    days[iso] = normalizeDayRecord(d);
  }
  return { products, days };
}

function getDayRecord(isoDate, profileKey = state.activeProfile) {
  const prof = getProfileData(profileKey);
  if (!prof.days[isoDate]) {
    prof.days[isoDate] = {
      sessions: [],
      sales: []
    };
  } else {
    prof.days[isoDate] = normalizeDayRecord(prof.days[isoDate]);
  }
  return prof.days[isoDate];
}

function calcDaySummary(dayRecord) {
  const norm = normalizeDayRecord(dayRecord);
  const sessions = norm.sessions || [];
  const sales = norm.sales || [];

  let earnings = 0;
  let fuel = 0;
  let km = 0;
  let trips = 0;
  let durationSeconds = 0;

  sessions.forEach((s) => {
    earnings += Number(s.earnings) || 0;
    fuel += Number(s.fuel) || 0;
    km += Number(s.km) || 0;
    trips += Number(s.trips) || 0;
    durationSeconds += Number(s.durationSeconds) || 0;
  });

  const uberNet = earnings - fuel;
  const salesGross = sales.reduce((acc, s) => acc + (Number(s.price) || 0), 0);
  const salesCost = sales.reduce((acc, s) => acc + (Number(s.cost) || 0), 0);
  const salesNet = salesGross - salesCost;

  const totalGross = earnings + salesGross;
  const totalNet = uberNet + salesNet;

  return {
    sessionsCount: sessions.length,
    durationSeconds,
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
// Cronômetro por Perfil (Persiste mesmo com tela bloqueada/fechada)
// ============================================================================

function getTimerState(profileKey = state.activeProfile) {
  const key = TIMER_STORAGE_PREFIX + profileKey;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { running: false, startedAt: null, accumulatedSec: 0 };
    const parsed = JSON.parse(raw);
    return {
      running: Boolean(parsed.running),
      startedAt: parsed.startedAt ? Number(parsed.startedAt) : null,
      accumulatedSec: Number(parsed.accumulatedSec) || 0
    };
  } catch (_) {
    return { running: false, startedAt: null, accumulatedSec: 0 };
  }
}

function saveTimerState(timerObj, profileKey = state.activeProfile) {
  const key = TIMER_STORAGE_PREFIX + profileKey;
  localStorage.setItem(key, JSON.stringify(timerObj));
}

function getElapsedTimerSeconds(profileKey = state.activeProfile) {
  const t = getTimerState(profileKey);
  if (!t.running || !t.startedAt) {
    return Math.max(0, Math.floor(t.accumulatedSec));
  }
  const now = Date.now();
  const deltaSec = Math.max(0, Math.floor((now - t.startedAt) / 1000));
  return Math.max(0, Math.floor(t.accumulatedSec + deltaSec));
}

function toggleTimerStartPause() {
  const t = getTimerState();
  if (t.running) {
    // Pausar
    const totalSec = getElapsedTimerSeconds();
    saveTimerState({
      running: false,
      startedAt: null,
      accumulatedSec: totalSec
    });
  } else {
    // Iniciar
    const timeInput = document.getElementById('uberTime');
    if (timeInput && !timeInput.value) {
      timeInput.value = getCurrentTimeHHMM();
    }
    saveTimerState({
      running: true,
      startedAt: Date.now(),
      accumulatedSec: t.accumulatedSec || 0
    });
  }
  updateStopwatchUI(true);
}

function resetTimer() {
  saveTimerState({
    running: false,
    startedAt: null,
    accumulatedSec: 0
  });
  const durInput = document.getElementById('uberDurationText');
  if (durInput) durInput.value = '00:00:00';
  updateStopwatchUI(false);
}

function updateStopwatchUI(syncInput = false) {
  const t = getTimerState();
  const elapsed = getElapsedTimerSeconds();
  const formatted = formatSecondsToHHMMSS(elapsed);

  const displayEl = document.getElementById('stopwatchDisplay');
  const badgeEl = document.getElementById('stopwatchStatusBadge');
  const btnStartPause = document.getElementById('btnTimerStartPause');
  const durInput = document.getElementById('uberDurationText');

  if (displayEl) displayEl.textContent = formatted;

  if (t.running) {
    if (badgeEl) {
      badgeEl.textContent = '⏱️ Rodando...';
      badgeEl.style.color = '#fbbf24';
    }
    if (btnStartPause) {
      btnStartPause.textContent = '⏸️ Pausar';
      btnStartPause.classList.remove('start');
      btnStartPause.classList.add('pause');
    }
    if (durInput && document.activeElement !== durInput) {
      durInput.value = formatted;
    }
  } else {
    if (badgeEl) {
      badgeEl.textContent = elapsed > 0 ? 'Pausado' : 'Parado';
      badgeEl.style.color = '';
    }
    if (btnStartPause) {
      btnStartPause.textContent = elapsed > 0 ? '▶️ Continuar' : '▶️ Iniciar';
      btnStartPause.classList.remove('pause');
      btnStartPause.classList.add('start');
    }
    if (syncInput && durInput && elapsed > 0) {
      durInput.value = formatted;
    }
  }
}

// ============================================================================
// Persistência Local + Sincronização na Nuvem (Suporta Perfis Lucas e Bianca)
// ============================================================================

function loadState() {
  try {
    const savedProfile = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (savedProfile === 'lucas' || savedProfile === 'bianca') {
      state.activeProfile = savedProfile;
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.updatedAt = 0;
      saveStateLocalOnly();
      return;
    }
    const parsed = JSON.parse(raw);

    if (parsed.profiles && typeof parsed.profiles === 'object') {
      state.profiles.lucas = normalizeProfileStructure(parsed.profiles.lucas);
      state.profiles.bianca = normalizeProfileStructure(parsed.profiles.bianca);
    } else if (Array.isArray(parsed.products) || typeof parsed.days === 'object') {
      // Migração automática dos dados anteriores para o perfil Lucas!
      state.profiles.lucas = normalizeProfileStructure({
        products: parsed.products,
        days: parsed.days
      });
      state.profiles.bianca = normalizeProfileStructure(null);
    }

    state.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();
    saveStateLocalOnly();
  } catch (err) {
    console.error('Erro ao carregar dados locais:', err);
  }
}

function saveStateLocalOnly() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        updatedAt: state.updatedAt,
        profiles: state.profiles
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
    text.textContent = label || 'Salvo local';
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
    profiles: state.profiles
  };

  let ok = false;

  try {
    const resNtfy = await fetch(CLOUD_NTFY_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (resNtfy.ok) ok = true;
  } catch (e) {
    console.warn('Falha ao publicar no canal realtime:', e);
  }

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
    if (remoteData.profiles && typeof remoteData.profiles === 'object') {
      state.profiles.lucas = normalizeProfileStructure(remoteData.profiles.lucas);
      state.profiles.bianca = normalizeProfileStructure(remoteData.profiles.bianca);
    } else if (Array.isArray(remoteData.products) || typeof remoteData.days === 'object') {
      state.profiles.lucas = normalizeProfileStructure({
        products: remoteData.products,
        days: remoteData.days
      });
    }
    saveStateLocalOnly();
    renderAll();
    setSyncStatusUI('synced', 'Sincronizado');
    if (notifyUser) {
      showToast('☁️ Dados sincronizados da nuvem!');
    }
    return true;
  }
  return false;
}

async function syncFromCloud(manualClick = false) {
  setSyncStatusUI('syncing', 'Sincronizando...');
  let bestRemote = null;

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

  // Se o formato na nuvem ainda era de 1 perfil (sem profiles.bianca), atualiza a nuvem com os 2 perfis
  const cloudMissingProfiles = bestRemote && !bestRemote.profiles;
  const remoteUpdated = Number(bestRemote?.updatedAt) || 0;
  const localUpdated = Number(state.updatedAt) || 0;

  if (remoteUpdated > localUpdated) {
    applyRemotePayloadIfNewer(bestRemote, manualClick);
    if (cloudMissingProfiles) {
      state.updatedAt = Date.now();
      saveStateLocalOnly();
      await pushToCloud();
    }
  } else if (localUpdated > remoteUpdated || cloudMissingProfiles) {
    await pushToCloud();
    if (manualClick) {
      showToast('☁️ Dados enviados para a nuvem!');
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

// ============================================================================
// Renderização da Interface
// ============================================================================

function renderAll() {
  renderProfileSwitcher();
  renderDateHeader();
  renderHeroAndLowStock();
  renderUberTab();
  renderSalesTab();
  renderInventoryTab();
  renderHistoryTab();
  updateStopwatchUI(false);
}

function renderProfileSwitcher() {
  document.body.dataset.activeProfile = state.activeProfile;
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.profile === state.activeProfile);
  });
  const profName = getProfileDisplayName();
  const heroProfileEl = document.getElementById('heroProfileName');
  if (heroProfileEl) heroProfileEl.textContent = profName.toUpperCase();

  const histProfileEl = document.getElementById('histProfileLabel');
  if (histProfileEl) histProfileEl.textContent = profName;
}

function renderDateHeader() {
  const dateInput = document.getElementById('selectedDate');
  const dateLabel = document.getElementById('dateFormattedLabel');
  dateInput.value = state.selectedDate;
  dateLabel.textContent = formatFriendlyDate(state.selectedDate);
}

function renderHeroAndLowStock() {
  const prof = getProfileData();
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

  // Verifica estoque baixo do perfil ativo
  const lowStockItems = prof.products.filter((p) => p.stock <= (p.minStock ?? 3));
  const banner = document.getElementById('lowStockBanner');
  const navBadge = document.getElementById('navStockBadge');

  if (lowStockItems.length > 0) {
    banner.classList.remove('hidden');
    navBadge.classList.remove('hidden');
    navBadge.textContent = lowStockItems.length;
    const names = lowStockItems.map((i) => `${i.emoji} ${i.name} (${i.stock})`).join(', ');
    document.getElementById('lowStockBannerText').textContent =
      `Estoque baixo (${getProfileDisplayName()}): ${names}`;
  } else {
    banner.classList.add('hidden');
    navBadge.classList.add('hidden');
  }
}

function updateFuelLitersPreview() {
  const fuelVal = parseFloat(document.getElementById('uberFuel')?.value) || 0;
  const priceVal = parseFloat(document.getElementById('uberFuelPrice')?.value) || 0;
  const hint = document.getElementById('fuelLitersPreview');
  if (!hint) return;
  if (fuelVal > 0 && priceVal > 0) {
    const liters = fuelVal / priceVal;
    hint.textContent = `Volume abastecido: ${formatNumber(liters, 2)} litros`;
  } else {
    hint.textContent = `Litros: 0,0 L`;
  }
}

function renderUberTab() {
  const day = getDayRecord(state.selectedDate);
  const summary = calcDaySummary(day);

  // Define horário padrão se estiver vazio e não estiver editando
  const timeInput = document.getElementById('uberTime');
  if (timeInput && !timeInput.value && document.activeElement !== timeInput) {
    timeInput.value = getCurrentTimeHHMM();
  }

  updateFuelLitersPreview();

  // Lista de sessões lançadas no dia
  document.getElementById('sessionsCountBadge').textContent = summary.sessionsCount;
  document.getElementById('totalDurationDayBadge').textContent =
    `Tempo total: ${formatSecondsToShortHM(summary.durationSeconds)}`;

  const listEl = document.getElementById('dailySessionsList');
  if (day.sessions.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        Nenhuma sessão de corrida salva em ${formatFriendlyDate(state.selectedDate)} no perfil <strong>${getProfileDisplayName()}</strong>.
        Preencha os campos acima e clique em <strong>Salvar Sessão de Corridas</strong>!
      </div>
    `;
  } else {
    listEl.innerHTML = day.sessions
      .map((sess, idx) => {
        const net = (Number(sess.earnings) || 0) - (Number(sess.fuel) || 0);
        const carIcon = sess.car === 'Yaris' ? '🚗' : '🚘';
        const durLabel =
          sess.durationSeconds > 0
            ? formatSecondsToShortHM(sess.durationSeconds)
            : sess.durationText && sess.durationText !== '00:00:00'
            ? sess.durationText
            : 'Sem cronômetro';

        const fuelPriceInfo =
          Number(sess.fuelPrice) > 0
            ? ` (${formatBRL(sess.fuelPrice)}/L${
                Number(sess.fuel) > 0
                  ? ' • ' + formatNumber(sess.fuel / sess.fuelPrice, 1) + 'L'
                  : ''
              })`
            : '';

        return `
          <div class="inv-card">
            <div class="inv-top">
              <div>
                <div class="inv-name">
                  Sessão #${idx + 1} • 🕒 ${escapeHtml(sess.time || '--:--')} • ${carIcon} ${escapeHtml(sess.car || 'Onix')}
                </div>
                <div class="session-badges">
                  <span class="session-tag">⏱️ ${escapeHtml(durLabel)}</span>
                  <span class="session-tag">🏁 ${Number(sess.trips) || 0} corridas</span>
                  <span class="session-tag">🛣️ ${formatNumber(sess.km || 0, 1)} km</span>
                </div>
                <div class="inv-prices" style="margin-top:6px;">
                  Bruto: <strong>${formatBRL(sess.earnings)}</strong> •
                  Combustível: ${formatBRL(sess.fuel)}${fuelPriceInfo}
                  ${sess.notes ? `<br/>🗒️ <em>${escapeHtml(sess.notes)}</em>` : ''}
                </div>
              </div>
              <div class="log-values">
                <span class="log-price text-emerald">${formatBRL(net)}</span>
                <span class="log-meta">Lucro Sessão</span>
              </div>
            </div>
            <div class="inv-bottom" style="justify-content: flex-end;">
              <div class="inv-actions">
                <button type="button" class="btn-icon-action" data-edit-session-id="${sess.sessionId}">✏️ Editar</button>
                <button type="button" class="btn-delete-sm" data-delete-session-id="${sess.sessionId}">🗑️ Excluir</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Métricas consolidadas do dia
  document.getElementById('metricUberProfit').textContent = formatBRL(summary.uberNet);

  const hoursWorked = summary.durationSeconds / 3600;
  const profitPerHourEl = document.getElementById('metricProfitPerHour');
  if (hoursWorked > 0) {
    profitPerHourEl.textContent = `Líquido/hora: ${formatBRL(summary.uberNet / hoursWorked)}/h`;
  } else {
    profitPerHourEl.textContent = `Ganhos − Combustível`;
  }

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
  const prof = getProfileData();
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

  const grid = document.getElementById('quickSaleGrid');
  if (prof.products.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        Nenhum item cadastrado no perfil <strong>${getProfileDisplayName()}</strong>. Vá na aba <strong>Estoque</strong> para cadastrar!
      </div>
    `;
  } else {
    grid.innerHTML = prof.products
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

  const logContainer = document.getElementById('dailySalesLog');
  if (day.sales.length === 0) {
    logContainer.innerHTML = `
      <div class="empty-state">
        Nenhuma venda registrada em ${formatFriendlyDate(state.selectedDate)} (${getProfileDisplayName()}).
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
  const prof = getProfileData();
  let totalUnits = 0;
  let totalCost = 0;
  let potentialProfit = 0;

  prof.products.forEach((p) => {
    const qty = Math.max(0, Number(p.stock) || 0);
    totalUnits += qty;
    totalCost += qty * (Number(p.cost) || 0);
    potentialProfit += qty * ((Number(p.price) || 0) - (Number(p.cost) || 0));
  });

  document.getElementById('stockTotalUnits').textContent = `${totalUnits} un.`;
  document.getElementById('stockTotalCost').textContent = formatBRL(totalCost);
  document.getElementById('stockPotentialProfit').textContent = formatBRL(potentialProfit);

  const list = document.getElementById('inventoryList');
  if (prof.products.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        O estoque de <strong>${getProfileDisplayName()}</strong> está vazio. Cadastre seus itens acima ou clique em "Carregar Exemplos".
      </div>
    `;
    return;
  }

  list.innerHTML = prof.products
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
  const prof = getProfileData();
  const todayISO = getTodayISO();
  const [ty, tm, td] = todayISO.split('-').map(Number);
  const todayObj = new Date(ty, tm - 1, td);

  const allDates = Object.keys(prof.days).sort((a, b) => b.localeCompare(a));

  const filteredDates = allDates.filter((iso) => {
    const sum = calcDaySummary(prof.days[iso]);
    const hasActivity =
      sum.sessionsCount > 0 ||
      sum.earnings > 0 ||
      sum.fuel > 0 ||
      sum.km > 0 ||
      sum.trips > 0 ||
      sum.salesCount > 0;
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
    const rec = normalizeDayRecord(prof.days[iso]);
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

  const topProductsEl = document.getElementById('topProductsList');
  const rankedProducts = Object.values(productStats).sort((a, b) => b.profit - a.profit);

  if (rankedProducts.length === 0) {
    topProductsEl.innerHTML = `<div class="empty-state">Nenhuma venda registrada neste período (${getProfileDisplayName()}).</div>`;
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

  const daysListEl = document.getElementById('historyDaysList');
  if (filteredDates.length === 0) {
    daysListEl.innerHTML = `<div class="empty-state">Nenhum registro encontrado neste período (${getProfileDisplayName()}).</div>`;
  } else {
    daysListEl.innerHTML = filteredDates
      .map((iso) => {
        const sum = calcDaySummary(prof.days[iso]);
        return `
          <div class="history-day-row" data-open-date="${iso}">
            <div>
              <div class="log-title">📅 ${formatFriendlyDate(iso)} <small style="color:var(--text-muted)">(${iso.split('-').reverse().join('/')})</small></div>
              <div class="log-meta">
                🚗 ${sum.sessionsCount} sess. (${sum.trips} corr. / ${formatNumber(sum.km, 0)}km / ⏱️ ${formatSecondsToShortHM(sum.durationSeconds)}) •
                🍫 Vendas: ${formatBRL(sum.salesNet)} (${sum.salesCount})
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

function switchProfile(profileKey) {
  if (profileKey !== 'lucas' && profileKey !== 'bianca') return;
  state.activeProfile = profileKey;
  localStorage.setItem(ACTIVE_PROFILE_KEY, profileKey);
  resetSessionForm();
  renderAll();
  showToast(`👤 Perfil ativo: ${getProfileDisplayName(profileKey)}`);
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === tabId);
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

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
  resetSessionForm();
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

function resetSessionForm() {
  const form = document.getElementById('uberSessionForm');
  if (!form) return;
  form.reset();
  document.getElementById('editingSessionId').value = '';
  document.getElementById('uberTime').value = getCurrentTimeHHMM();
  document.getElementById('uberCar').value = 'Onix';
  document.getElementById('sessionFormTitle').textContent = '📝 Lançar Sessão de Corridas';
  document.getElementById('btnSaveUberSession').textContent = '💾 Salvar Sessão de Corridas';
  document.getElementById('btnCancelEditSession').classList.add('hidden');
  updateFuelLitersPreview();
}

function registerQuickSale(productId) {
  const prof = getProfileData();
  const prod = prof.products.find((p) => p.id === productId);
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
    `✅ Venda (${getProfileDisplayName()}): ${prod.emoji} ${prod.name} (+${formatBRL(profit)})`,
    'Desfazer',
    () => refundSale(saleEntry.saleId)
  );
}

function refundSale(saleId) {
  const prof = getProfileData();
  const day = getDayRecord(state.selectedDate);
  const idx = day.sales.findIndex((s) => s.saleId === saleId);
  if (idx === -1) return;

  const [removed] = day.sales.splice(idx, 1);
  const prod = prof.products.find((p) => p.id === removed.productId);
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
  resetSessionForm();
  renderAll();
  syncFromCloud(false);
  startRealtimeSyncListener();

  // Loop de atualização do cronômetro a cada 1s
  if (stopwatchInterval) clearInterval(stopwatchInterval);
  stopwatchInterval = setInterval(() => {
    updateStopwatchUI(false);
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateStopwatchUI(false);
      syncFromCloud(false);
    }
  });
  window.addEventListener('focus', () => {
    updateStopwatchUI(false);
    syncFromCloud(false);
  });

  // Seletor de Perfil (Lucas / Bianca)
  document.querySelectorAll('.profile-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchProfile(btn.dataset.profile));
  });

  // Botões do Cronômetro
  document.getElementById('btnTimerStartPause').addEventListener('click', toggleTimerStartPause);
  document.getElementById('btnTimerReset').addEventListener('click', () => {
    if (getElapsedTimerSeconds() > 0 && !confirm('Deseja zerar o cronômetro atual?')) return;
    resetTimer();
  });

  // Botão de sincronização no topo
  const btnCloudSync = document.getElementById('btnCloudSync');
  if (btnCloudSync) {
    btnCloudSync.addEventListener('click', () => syncFromCloud(true));
  }

  // Botão para forçar envio dos dados deste aparelho para a nuvem
  const btnForcePush = document.getElementById('btnForcePushCloud');
  if (btnForcePush) {
    btnForcePush.addEventListener('click', async () => {
      state.updatedAt = Date.now();
      saveStateLocalOnly();
      await pushToCloud();
      showToast('☁️ Dados de Lucas e Bianca enviados para a nuvem!');
    });
  }

  // Service Worker (PWA)
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

  // Preview de litros ao digitar combustível ou preço por litro
  document.getElementById('uberFuel').addEventListener('input', updateFuelLitersPreview);
  document.getElementById('uberFuelPrice').addEventListener('input', updateFuelLitersPreview);

  // Botões de adição rápida (+R$ 15, +R$ 50, +10km, etc.) no formulário de sessão
  document.querySelectorAll('[data-add-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fieldId = btn.dataset.addField;
      const amount = parseFloat(btn.dataset.amount) || 0;
      const inputEl = document.getElementById(fieldId);
      const currentVal = parseFloat(inputEl.value) || 0;
      const nextVal = Math.round((currentVal + amount) * 100) / 100;
      inputEl.value = nextVal;
      updateFuelLitersPreview();
    });
  });

  // Stepper de número de corridas (- / +) no formulário de sessão
  document.getElementById('btnDecrementTrip').addEventListener('click', () => {
    const input = document.getElementById('uberTrips');
    const cur = parseInt(input.value, 10) || 0;
    input.value = Math.max(0, cur - 1);
  });

  document.getElementById('btnIncrementTrip').addEventListener('click', () => {
    const input = document.getElementById('uberTrips');
    const cur = parseInt(input.value, 10) || 0;
    input.value = cur + 1;
  });

  // Cancelar edição de sessão
  document.getElementById('btnCancelEditSession').addEventListener('click', resetSessionForm);

  // Salvar Sessão de Corridas
  document.getElementById('uberSessionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const editingId = document.getElementById('editingSessionId').value;
    const time = document.getElementById('uberTime').value || getCurrentTimeHHMM();
    const car = document.getElementById('uberCar').value || 'Onix';
    const earnings = Math.max(0, parseFloat(document.getElementById('uberEarnings').value) || 0);
    const fuel = Math.max(0, parseFloat(document.getElementById('uberFuel').value) || 0);
    const fuelPrice = Math.max(0, parseFloat(document.getElementById('uberFuelPrice').value) || 0);
    const km = Math.max(0, parseFloat(document.getElementById('uberKm').value) || 0);
    const trips = Math.max(0, parseInt(document.getElementById('uberTrips').value, 10) || 0);
    const notes = document.getElementById('uberNotes').value.trim();

    const durationInputVal = document.getElementById('uberDurationText').value.trim();
    const timerElapsed = getElapsedTimerSeconds();
    let durationSeconds = parseHHMMSSToSeconds(durationInputVal);
    if (durationSeconds === 0 && timerElapsed > 0) {
      durationSeconds = timerElapsed;
    }
    const durationText = formatSecondsToHHMMSS(durationSeconds);

    const day = getDayRecord(state.selectedDate);

    if (editingId) {
      const existing = day.sessions.find((s) => s.sessionId === editingId);
      if (existing) {
        existing.time = time;
        existing.car = car;
        existing.earnings = earnings;
        existing.fuel = fuel;
        existing.fuelPrice = fuelPrice;
        existing.km = km;
        existing.trips = trips;
        existing.durationSeconds = durationSeconds;
        existing.durationText = durationText;
        existing.notes = notes;
      }
      showToast(`✅ Sessão atualizada (${getProfileDisplayName()})!`);
    } else {
      day.sessions.push({
        sessionId: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        time,
        car,
        earnings,
        fuel,
        fuelPrice,
        km,
        trips,
        durationSeconds,
        durationText,
        notes
      });
      // Ao salvar uma nova sessão, zera o cronômetro para a próxima!
      resetTimer();
      showToast(`✅ Sessão salva em ${formatFriendlyDate(state.selectedDate)} (${getProfileDisplayName()})!`);
    }

    saveState();
    resetSessionForm();
    renderAll();
  });

  // Editar ou Excluir Sessão na lista do dia
  document.getElementById('dailySessionsList').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-session-id]');
    if (editBtn) {
      const day = getDayRecord(state.selectedDate);
      const sess = day.sessions.find((s) => s.sessionId === editBtn.dataset.editSessionId);
      if (sess) {
        document.getElementById('editingSessionId').value = sess.sessionId;
        document.getElementById('uberTime').value = sess.time || '08:00';
        document.getElementById('uberCar').value = sess.car || 'Onix';
        document.getElementById('uberEarnings').value = sess.earnings || '';
        document.getElementById('uberFuel').value = sess.fuel || '';
        document.getElementById('uberFuelPrice').value = sess.fuelPrice || '';
        document.getElementById('uberKm').value = sess.km || '';
        document.getElementById('uberTrips').value = sess.trips || '';
        document.getElementById('uberDurationText').value =
          sess.durationText || formatSecondsToHHMMSS(sess.durationSeconds || 0);
        document.getElementById('uberNotes').value = sess.notes || '';

        document.getElementById('sessionFormTitle').textContent = `✏️ Editando Sessão (${sess.time})`;
        document.getElementById('btnSaveUberSession').textContent = '💾 Atualizar Sessão';
        document.getElementById('btnCancelEditSession').classList.remove('hidden');
        updateFuelLitersPreview();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-session-id]');
    if (delBtn) {
      const day = getDayRecord(state.selectedDate);
      const sess = day.sessions.find((s) => s.sessionId === delBtn.dataset.deleteSessionId);
      if (sess && confirm(`Deseja excluir esta sessão das ${sess.time || '--:--'}?`)) {
        day.sessions = day.sessions.filter((s) => s.sessionId !== sess.sessionId);
        saveState();
        renderAll();
        showToast('🗑️ Sessão removida.');
      }
    }
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
    const prof = getProfileData();
    const id = document.getElementById('productId').value;
    const emoji = document.getElementById('productEmoji').value;
    const name = document.getElementById('productName').value.trim();
    const price = parseFloat(document.getElementById('productPrice').value) || 0;
    const cost = parseFloat(document.getElementById('productCost').value) || 0;
    const stock = parseInt(document.getElementById('productStock').value, 10) || 0;
    const minStock = parseInt(document.getElementById('productMinStock').value, 10) || 0;

    if (!name) return;

    if (id) {
      const existing = prof.products.find((p) => p.id === id);
      if (existing) {
        existing.emoji = emoji;
        existing.name = name;
        existing.price = price;
        existing.cost = cost;
        existing.stock = Math.max(0, stock);
        existing.minStock = Math.max(0, minStock);
      }
      showToast(`✅ Item "${name}" atualizado (${getProfileDisplayName()})!`);
    } else {
      prof.products.push({
        id: 'prod_' + Date.now(),
        emoji,
        name,
        price,
        cost,
        stock: Math.max(0, stock),
        minStock: Math.max(0, minStock)
      });
      showToast(`✅ Item "${name}" cadastrado no estoque de ${getProfileDisplayName()}!`);
    }

    saveState();
    resetProductForm();
    renderAll();
  });

  document.getElementById('btnLoadSamples').addEventListener('click', () => {
    const prof = getProfileData();
    DEFAULT_PRODUCTS.forEach((sample) => {
      if (!prof.products.some((p) => p.name.toLowerCase() === sample.name.toLowerCase())) {
        prof.products.push({ ...sample, id: 'prod_' + Date.now() + Math.random().toString(36).slice(2, 5) });
      }
    });
    saveState();
    renderAll();
    showToast(`📦 Itens de exemplo adicionados ao estoque de ${getProfileDisplayName()}!`);
  });

  // Ações nos cards de estoque
  document.getElementById('inventoryList').addEventListener('click', (e) => {
    const prof = getProfileData();
    const stockBtn = e.target.closest('[data-stock-id]');
    if (stockBtn) {
      const prod = prof.products.find((p) => p.id === stockBtn.dataset.stockId);
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
      const prod = prof.products.find((p) => p.id === editBtn.dataset.editId);
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
      const prod = prof.products.find((p) => p.id === deleteBtn.dataset.deleteId);
      if (prod && confirm(`Deseja remover "${prod.name}" do estoque de ${getProfileDisplayName()}?`)) {
        prof.products = prof.products.filter((p) => p.id !== prod.id);
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

  // Exportar e Importar Backup JSON (inclui ambos os perfis)
  document.getElementById('btnExportData').addEventListener('click', () => {
    const dataStr = JSON.stringify({ profiles: state.profiles, updatedAt: state.updatedAt }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-uber-lucas-bianca-${getTodayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('💾 Backup completo (Lucas e Bianca) exportado!');
  });

  document.getElementById('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported.profiles && typeof imported.profiles === 'object') {
          state.profiles.lucas = normalizeProfileStructure(imported.profiles.lucas);
          state.profiles.bianca = normalizeProfileStructure(imported.profiles.bianca);
          saveState();
          renderAll();
          showToast('✅ Backup de Lucas e Bianca restaurado com sucesso!');
        } else if (Array.isArray(imported.products) && typeof imported.days === 'object') {
          state.profiles[state.activeProfile] = normalizeProfileStructure(imported);
          saveState();
          renderAll();
          showToast(`✅ Backup restaurado no perfil ${getProfileDisplayName()}!`);
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

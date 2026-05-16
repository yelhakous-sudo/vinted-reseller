const BRAND_RESALE = {
  supreme: 2.5, nike: 1.6, adidas: 1.4, jordan: 2.5,
  yeezy: 2.8, gucci: 2.0, "louis vuitton": 2.3, zara: 1.15,
  carhartt: 1.5, patagonia: 1.6, "the north face": 1.7,
  "stone island": 2.0, "cp company": 1.8, "arc'teryx": 1.9,
  balenciaga: 2.2, "off-white": 2.5, prada: 1.9, dior: 2.3,
  "rick owens": 2.4, vetements: 2.0, "maison margiela": 2.2,
  moncler: 1.9, "canada goose": 1.8, diesel: 1.25,
  boss: 1.15, "calvin klein": 1.15, "tommy hilfiger": 1.2,
  "ralph lauren": 1.3, lacoste: 1.25, levis: 1.2,
  "helmut lang": 1.7, "rafs simons": 2.6, "acne studios": 1.5,
  "ami paris": 1.4, "carhartt wip": 1.6, stussy: 1.5,
  "palm angels": 1.8, essentials: 1.5, represent: 1.4,
};

const CONDITION_VALUE = {
  new_with_tags: 1.0, new_without_tags: 0.85, very_good: 0.75,
  good: 0.60, satisfactory: 0.45, not_specified: 0.50,
};

// Top 18 most profitable keywords - fast scan
const SEARCH_TERMS = [
  "nike", "adidas", "jordan", "supreme", "yeezy",
  "carhartt", "the north face", "stone island", "gucci", "prada",
  "moncler", "ralph lauren", "lacoste", "boss", "hoodie",
  "veste", "basket", "doudoune",
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---- Session cache (persists across warm starts) ----
let cachedToken = '';
let cachedCookie = '';
let lastInit = 0;

function getCookiesFromResponse(resp) {
  const methods = [
    () => resp.headers.getSetCookie?.(),
    () => resp.headers.raw?.()?.['set-cookie'],
    () => { const v = resp.headers.get('set-cookie'); return v ? [v] : null; },
  ];
  for (const fn of methods) {
    try {
      const result = fn();
      if (result && result.length > 0) return result;
    } catch {}
  }
  return [];
}

async function initSession() {
  const resp = await fetch('https://www.vinted.fr/', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' },
    redirect: 'follow',
  });
  const raw = getCookiesFromResponse(resp);
  const pairs = raw.map(c => c.split(';')[0]);
  cachedCookie = pairs.join('; ');
  const atCookies = pairs.filter(p => p.startsWith('access_token_web='));
  cachedToken = atCookies.length > 0 ? atCookies[atCookies.length - 1].split('=')[1] : '';
  lastInit = Date.now();
}

function analyzeItem(item) {
  try {
    const price = parseFloat(item.price?.amount);
    if (isNaN(price) || price <= 0 || price > 300) return null;
    const title = item.title || '';
    const brandTitle = item.brand_title || '';
    const status = item.status || 'not_specified';
    const text = `${brandTitle} ${title}`.toLowerCase();
    let bm = 1.0;
    for (const [brand, mult] of Object.entries(BRAND_RESALE)) {
      if (text.includes(brand) && mult > bm) bm = mult;
    }
    const cm = CONDITION_VALUE[status] || 0.5;
    const estimated = Math.round(Math.max(price * bm * (0.65 + 0.35 * cm), price * 1.1) * 100) / 100;
    const profit = Math.round((estimated - price) * 100) / 100;
    if (profit < 20) return null;
    const score = Math.round(profit * ((profit / price) * 100 / 100) * 10) / 10;
    return {
      id: item.id, title, brand: brandTitle, price, estimated, profit, score,
      status: status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      size: item.size_title || '', url: item.url || '',
      favs: item.favourite_count || 0, views: item.view_count || 0,
      seller: item.user?.login || '?',
      photo: item.photos?.[0]?.url || item.photo?.url || '',
    };
  } catch { return null; }
}

async function fetchKeyword(keyword) {
  const headers = {
    'Authorization': `Bearer ${cachedToken}`,
    'Accept': 'application/json',
    'User-Agent': UA,
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (cachedCookie) headers['Cookie'] = cachedCookie;

  const params = new URLSearchParams({
    search_text: keyword, page: '1', per_page: '20', order: 'newest_first',
  });

  const resp = await fetch(`https://www.vinted.fr/api/v2/catalog/items?${params}`, { headers });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.items || [];
}

export async function handler(event, context) {
  const start = Date.now();
  const logs = [];

  // 1. Init session
  try {
    if (!cachedToken || Date.now() - lastInit > 240000) await initSession();
    logs.push(`token:${cachedToken.slice(0, 10)}... len:${cachedToken.length}`);
  } catch (e) {
    logs.push(`init_err:${e.message}`);
  }

  if (!cachedToken || cachedToken.length < 20) {
    return { statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ deals: [], debug: { error: 'Impossible de se connecter a Vinted (session bloque)', logs } }) };
  }

  // 2. Fetch all keywords in parallel (fastest approach for serverless)
  const allDeals = [];
  try {
    const results = await Promise.all(SEARCH_TERMS.map(k => fetchKeyword(k)));
    logs.push(`keywords:${SEARCH_TERMS.length}`);
    let totalItems = 0;
    for (const items of results) {
      totalItems += items.length;
      for (const item of items) {
        const deal = analyzeItem(item);
        if (deal) allDeals.push(deal);
      }
    }
    logs.push(`items:${totalItems} deals:${allDeals.length}`);
  } catch (e) {
    logs.push(`fetch_err:${e.message}`);
  }

  // 3. If token expired (all requests returned 0 items), retry once
  if (allDeals.length === 0 && logs.some(l => l.startsWith('items:0'))) {
    logs.push('retry_init');
    try {
      await initSession();
      const results = await Promise.all(SEARCH_TERMS.map(k => fetchKeyword(k)));
      for (const items of results) {
        for (const item of items) {
          const deal = analyzeItem(item);
          if (deal) allDeals.push(deal);
        }
      }
    } catch (e) { logs.push(`retry_err:${e.message}`); }
  }

  allDeals.sort((a, b) => b.score - a.score);
  const elapsed = Date.now() - start;
  logs.push(`time:${elapsed}ms`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ deals: allDeals.slice(0, 10), debug: { logs } }),
  };
}

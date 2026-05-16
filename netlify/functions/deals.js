let accessToken = '';
let cookieStr = '';
let lastInit = 0;
let initAttempts = 0;

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

const SEARCH_TERMS = [
  "nike", "adidas", "jordan", "supreme", "yeezy",
  "carhartt", "zara", "the north face", "stone island",
  "gucci", "prada", "moncler", "boss", "ralph lauren",
  "lacoste", "levis", "hoodie", "veste", "basket",
  "doudoune", "pull", "jeans", "t-shirt", "manteau",
  "blouson", "sweat", "pantalon", "chemise", "parka",
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseSetCookies(resp) {
  try {
    // Node 19+ method
    if (typeof resp.headers.getSetCookie === 'function') {
      const c = resp.headers.getSetCookie();
      if (c && c.length > 0) return c;
    }
  } catch {}

  try {
    // Node.js undici internal
    const raw = resp.headers.raw();
    if (raw && raw['set-cookie'] && raw['set-cookie'].length > 0) {
      return raw['set-cookie'];
    }
  } catch {}

  try {
    // Fallback: single header
    const single = resp.headers.get('set-cookie');
    if (single) return [single];
  } catch {}

  return [];
}

async function initSession() {
  initAttempts++;
  const resp = await fetch('https://www.vinted.fr/', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' },
    redirect: 'follow',
  });

  const rawCookies = parseSetCookies(resp);
  const pairs = rawCookies.map(c => c.split(';')[0]);
  cookieStr = pairs.join('; ');
  const atCookies = pairs.filter(p => p.startsWith('access_token_web='));
  accessToken = atCookies.length > 0 ? atCookies[atCookies.length - 1].split('=')[1] : '';
  lastInit = Date.now();
}

function getBrandMult(title, brandTitle) {
  const text = `${brandTitle} ${title}`.toLowerCase();
  let best = 1.0;
  for (const [brand, mult] of Object.entries(BRAND_RESALE)) {
    if (text.includes(brand) && mult > best) best = mult;
  }
  return best;
}

function analyzeItem(item) {
  try {
    const price = parseFloat(item.price?.amount);
    if (isNaN(price) || price <= 0 || price > 300) return null;

    const title = item.title || '';
    const brandTitle = item.brand_title || '';
    const status = item.status || 'not_specified';
    const bm = getBrandMult(title, brandTitle);
    const cm = CONDITION_VALUE[status] || 0.5;
    const estimated = Math.round(Math.max(price * bm * (0.65 + 0.35 * cm), price * 1.1) * 100) / 100;
    const profit = Math.round((estimated - price) * 100) / 100;
    if (profit < 20) return null;

    const roi = (profit / price) * 100;
    const score = Math.round(profit * (roi / 100) * 10) / 10;

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
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    'User-Agent': UA,
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (cookieStr) headers['Cookie'] = cookieStr;

  const params = new URLSearchParams({
    search_text: keyword, page: '1', per_page: '20', order: 'newest_first',
  });

  const resp = await fetch(`https://www.vinted.fr/api/v2/catalog/items?${params}`, { headers });

  if (resp.status === 401 && initAttempts < 3) {
    await initSession();
    headers['Authorization'] = `Bearer ${accessToken}`;
    const retry = await fetch(`https://www.vinted.fr/api/v2/catalog/items?${params}`, { headers });
    if (!retry.ok) return [];
    const data = await retry.json();
    return data.items || [];
  }

  if (!resp.ok) return [];
  const data = await resp.json();
  return data.items || [];
}

export async function handler(event, context) {
  const errors = [];
  let sessionOk = false;

  try {
    if (!accessToken || Date.now() - lastInit > 300000) {
      await initSession();
    }
    sessionOk = accessToken.length > 20;
    if (!sessionOk) errors.push('Session init failed: no access token');
  } catch (e) {
    errors.push(`Session error: ${e.message}`);
  }

  if (!sessionOk) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        deals: [],
        debug: { error: errors.join('; '), sessionOk, initAttempts },
      }),
    };
  }

  const allDeals = [];
  const MIN_PROFIT = 20;
  const TARGET = 10;
  let keywordsSearched = 0;

  const BATCH_SIZE = 5;
  for (let i = 0; i < SEARCH_TERMS.length && allDeals.length < TARGET; i += BATCH_SIZE) {
    const batch = SEARCH_TERMS.slice(i, i + BATCH_SIZE);
    keywordsSearched += batch.length;

    try {
      const results = await Promise.all(batch.map(k => fetchKeyword(k)));

      for (const items of results) {
        for (const item of items) {
          if (allDeals.length >= TARGET) break;
          const deal = analyzeItem(item);
          if (deal) allDeals.push(deal);
        }
        if (allDeals.length >= TARGET) break;
      }
    } catch (e) {
      errors.push(`Batch error: ${e.message}`);
    }
  }

  allDeals.sort((a, b) => b.score - a.score);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      deals: allDeals.slice(0, TARGET),
      debug: { keywordsSearched, dealsFound: allDeals.length, sessionOk, errors: errors.length ? errors : undefined },
    }),
  };
}

/**
 * ForkFlip Proxy Worker — Tavily Edition
 * Gebruikt Tavily Search API voor Machineseeker NL resultaten.
 * Tavily lost JS-rendering op — directe scraping werkte niet.
 */

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if (!query || query.trim().length < 2) {
      return new Response(
        JSON.stringify({ error: 'Missing query ?q=', results: [], count: 0 }),
        { headers: corsHeaders, status: 400 }
      );
    }

    if (!env.TAVILY_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'TAVILY_API_KEY not set', results: [], count: 0 }),
        { headers: corsHeaders, status: 500 }
      );
    }

    try {
      const results = await searchViaTavily(query.trim(), env.TAVILY_API_KEY);
      const pricesFound = results.filter(l => l.price > 0).length;
      return new Response(
        JSON.stringify({
          query: query.trim(), source: 'machineseeker', country: 'NL',
          results, count: results.length,
          meta: {
            pricesFound,
            marketMedian: results[0]?.marketAvg || 0,
            note: `Potentie berekend op basis van ${pricesFound} live prijzen`
          }
        }),
        { headers: corsHeaders }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message, results: [], count: 0 }),
        { headers: corsHeaders, status: 500 }
      );
    }
  }
};

async function searchViaTavily(query, apiKey) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query: `site:machineseeker.nl ${query}`,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
      max_results: 10,
      include_domains: ['machineseeker.nl', 'www.machineseeker.nl']
    })
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Tavily ${response.status}: ${txt.substring(0, 200)}`);
  }

  const data = await response.json();
  if (!data.results || data.results.length === 0) return [];

  // FIX 1: Deduplicatie op URL
  const seen = new Set();
  const unique = data.results.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  const listings = unique
    .filter(r => r.url && r.title)
    .map((r, i) => normalizeTavilyResult(r, query, i));

  // FIX 2: Prijs enrichment — haal eerste 5 pagina's parallel op
  const enriched = await Promise.all(
    listings.slice(0, 5).map(l => enrichWithPrice(l))
  );
  const rest = listings.slice(5);
  const allListings = [...enriched, ...rest];

  // V22: Gaspedaal prijsanalyse
  return calculateLivePotential(allListings);
}

function calculateLivePotential(listings) {
  const prices = listings.map(l => l.price).filter(p => p > 0);

  if (prices.length < 2) {
    return listings.map(l => ({ ...l, marketAvg: 0, estimatedResale: 0, potentialNote: 'Onvoldoende prijsdata' }));
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2)
    : sorted[Math.floor(sorted.length/2)];

  return listings.map(l => {
    if (l.price <= 0) {
      return { ...l, marketAvg: median, estimatedResale: 0, potentialNote: 'Prijs onbekend' };
    }
    const pctDiff = Math.round(((median - l.price) / median) * 100);
    return {
      ...l,
      marketAvg: median,
      estimatedResale: median,
      potentialNote: `${pctDiff > 0 ? '+' : ''}${pctDiff}% vs. ${prices.length} live listings`
    };
  });
}

// FIX 2: Prijs + foto ophalen van listing pagina
async function enrichWithPrice(listing) {
  if (!listing.source_url || listing.price > 0) return listing;
  try {
    const resp = await fetch(listing.source_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'nl-NL,nl;q=0.9'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) return listing;
    const html = await resp.text();
    // Prijs
    for (const p of [/itemprop="price"[^>]*content="([\d.,]+)"/i, /"price"\s*:\s*"?([\d.,]+)/i,
      /class="[^"]*price[^"]*"[^>]*>[^<]*?(\d[\d.,]+)\s*(?:EUR|\u20ac)/i,
      /(\d{1,3}(?:\.\d{3})+)\s*(?:EUR|\u20ac)/]) {
      const m = html.match(p);
      if (m) {
        const val = Math.round(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
        if (val >= 200 && val <= 2000000) { listing.price = val; break; }
      }
    }
    // Foto
    for (const p of [/og:image"[^>]*content="([^"]+)"/i, /itemprop="image"[^>]*(?:src|content)="([^"]+)"/i]) {
      const m = html.match(p);
      if (m && m[1].startsWith('http')) { listing.image_url = m[1]; break; }
    }
  } catch (e) { /* stille fail */ }
  return listing;
}

// FIX 4: Strip Machineseeker ruis uit modelnaam
function cleanExternalModel(model) {
  return model
    .replace(/gebruikt\s+te\s+koop[^$]*/gi, '')
    .replace(/te\s+koop[^$]*/gi, '')
    .replace(/tweedehands\s+te\s+koop[^$]*/gi, '')
    .replace(/tweedehands[^$]*/gi, '')
    .replace(/op\s+machineseeker[^$]*/gi, '')
    .replace(/machineseeker\s*nl/gi, '')
    .replace(/[-\u2013\u2014]\s*machineseeker.*/gi, '')
    .replace(/\|\s*.*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTavilyResult(result, query, index) {
  const title = (result.title || '').trim();
  const content = (result.content || '').trim();
  const combined = title + ' ' + content;

  const price = extractPrice(combined);
  const year = extractYear(combined);
  const hours = extractHours(content);
  const region = extractRegion(content) || 'NL';

  // Try title first, then fall back to query for brand/model
  let { brand, model: rawModel } = splitTitle(title);
  let model = cleanExternalModel(rawModel);

  // If brand is generic (not a real equipment brand), use query
  const genericWords = ['hoogwerker','heftruck','forklift','schaarlift','verreiker',
    'palletwagen','machine','tweedehands','gebruikt','koop','zoek','alle','advertenties'];
  if (genericWords.includes(brand.toLowerCase()) || brand === '\u2014' || brand.length < 2) {
    const fromQuery = splitTitle(query);
    if (!genericWords.includes(fromQuery.brand.toLowerCase())) {
      brand = fromQuery.brand;
    }
  }
  // If model is empty or generic, try cleaned title
  if (!model || model === '\u2014' || model.length < 2 || genericWords.includes(model.toLowerCase())) {
    model = cleanExternalModel(title) || query;
    // Still generic? Skip this result
    if (genericWords.includes(model.toLowerCase())) model = query;
  }

  // Remove brand prefix from model if duplicated
  let finalModel = model;
  if (finalModel.toLowerCase().startsWith(brand.toLowerCase())) {
    finalModel = finalModel.substring(brand.length).trim();
  }
  if (!finalModel || finalModel.length < 2) finalModel = model;

  return {
    id: `tavily_${Date.now()}_${index}`,
    brand, model: finalModel,
    fullTitle: title,
    price, year, hours,
    condition: '\u2014', region,
    source: 'machineseeker',
    source_url: result.url,
    estimatedResale: 0,
    snippet: content.substring(0, 150),
    external: true,
    liveResult: true
  };
}

function extractPrice(text) {
  const patterns = [
    /\u20ac\s*([\d]{1,3}(?:[.,]\d{3})+)/,
    /\u20ac\s*([\d]{3,6})/,
    /([\d]{1,3}(?:\.\d{3})+)\s*(?:EUR|euro)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = Math.round(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
      if (val >= 200 && val <= 2000000) return val;
    }
  }
  return 0;
}

function extractYear(text) {
  const m = text.match(/\b(19[89]\d|200\d|201\d|202[0-6])\b/);
  return m ? parseInt(m[1]) : 0;
}

function extractHours(text) {
  const m = text.match(/(\d[\d.]*)\s*(?:uur|uren|bedrijfsuren)/i);
  return m ? parseInt(m[1].replace(/\./g, '')) : 0;
}

function extractRegion(text) {
  const cities = ['Amsterdam','Rotterdam','Utrecht','Den Haag','Eindhoven',
    'Tilburg','Groningen','Almere','Breda','Nijmegen','Haarlem',
    'Apeldoorn','Arnhem','Enschede','Amersfoort','Zwolle','Maastricht'];
  for (const city of cities) {
    if (text.includes(city)) return city;
  }
  return 'NL';
}

function splitTitle(title) {
  const knownBrands = [
    'Toyota','Linde','Still','Jungheinrich','Nissan','Manitou',
    'JLG','Genie','Haulotte','Skyjack','Hyster','Yale','Crown',
    'Bobcat','JCB','Merlo','Niftylift','Dingli','Caterpillar','CAT',
    'Komatsu','Kubota','Yanmar','Hitachi','Volvo','Liebherr','Terex',
    'New Holland','John Deere','Case','Fendt','Claas','MAN','DAF',
    'Scania','Iveco','Mercedes','Renault','Doosan','Mitsubishi',
    'Hyundai','Kramer','Wacker','Bomag','Hamm','Palfinger','Kalmar',
    'Combilift','Ausa','Hiab','Fassi','Tadano','Grove'
  ];

  if (!title) return { brand: '\u2014', model: '\u2014' };
  for (const b of knownBrands) {
    if (title.toLowerCase().startsWith(b.toLowerCase())) {
      return { brand: b, model: title.substring(b.length).trim() || title };
    }
  }
  for (const b of knownBrands) {
    if (title.toLowerCase().includes(b.toLowerCase())) {
      return { brand: b, model: title.replace(new RegExp(b, 'i'), '').trim() || title };
    }
  }
  const parts = title.split(/\s+/);
  return { brand: parts[0] || '\u2014', model: parts.slice(1).join(' ') || title };
}

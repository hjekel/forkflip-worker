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
      return new Response(
        JSON.stringify({ query: query.trim(), source: 'machineseeker', country: 'NL', results, count: results.length }),
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

  return data.results
    .filter(r => r.url && r.title)
    .map((r, i) => normalizeTavilyResult(r, query, i));
}

function normalizeTavilyResult(result, query, index) {
  const title = (result.title || '').trim();
  const content = (result.content || '').trim();
  const combined = title + ' ' + content;

  const price = extractPrice(combined);
  const year = extractYear(combined);
  const hours = extractHours(content);
  const region = extractRegion(content) || 'NL';
  const { brand, model } = splitTitle(title);

  return {
    id: `tavily_${Date.now()}_${index}`,
    brand, model,
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

// ForkFlip Proxy Worker v1.0 — deployed via GitHub Actions
/**
 * ForkFlip Proxy Worker
 * Fetcht machineseeker.nl zoekresultaten en geeft JSON terug.
 * Lost CORS-blokkade op voor de statische GitHub Pages frontend.
 *
 * URL: https://forkflip-proxy.hjekel.workers.dev/?q=JLG+Toucan
 * GitHub: https://github.com/hjekel/forkflip-worker
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
        JSON.stringify({ error: 'Missing query ?q=', results: [] }),
        { headers: corsHeaders, status: 400 }
      );
    }

    const debug = url.searchParams.get('debug') === '1';

    try {
      const results = await fetchMachineseeker(query.trim(), debug);
      const response_data = {
        query: query.trim(),
        source: 'machineseeker',
        country: 'NL',
        results: debug ? [] : results,
        count: debug ? 0 : results.length
      };
      if (debug && results._html) response_data.htmlSample = results._html;
      return new Response(
        JSON.stringify(response_data),
        { headers: corsHeaders }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message, results: [] }),
        { headers: corsHeaders, status: 500 }
      );
    }
  }
};

async function fetchMachineseeker(query, debug) {
  const q = encodeURIComponent(query);
  const searchUrl = `https://www.machineseeker.nl/main/search/index?search-word=${q}`;

  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'Referer': 'https://www.machineseeker.nl/'
    }
  });

  if (!response.ok) {
    throw new Error(`Machineseeker HTTP ${response.status}`);
  }

  const html = await response.text();
  if (debug) {
    // Show different parts of the HTML
    return {
      _htmlLength: html.length,
      _head: html.substring(0, 2000),
      _middle: html.substring(Math.floor(html.length/3), Math.floor(html.length/3) + 3000),
      _hasArticle: html.includes('<article'),
      _hasEuro: html.includes('EUR') || html.includes('\u20ac'),
      _hasListingClass: html.includes('listing') || html.includes('result') || html.includes('offer'),
      _sampleAroundEuro: (function() {
        var i = html.indexOf('EUR');
        if (i < 0) i = html.indexOf('\u20ac');
        if (i < 0) return 'No EUR/euro found';
        return html.substring(Math.max(0, i-200), i+200);
      })()
    };
  }
  return parseMachineseekerHTML(html, query);
}

function parseMachineseekerHTML(html, query) {
  const results = [];
  let blocks = [];
  let m;

  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  while ((m = articlePattern.exec(html)) !== null) {
    blocks.push(m[0]);
  }

  if (blocks.length < 3) {
    blocks = [];
    const divPattern = /<div[^>]*class="[^"]*\b(?:item|result|offer|listing)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = divPattern.exec(html)) !== null && blocks.length < 25) {
      if (m[0].length > 200 && m[0].length < 5000) blocks.push(m[0]);
    }
  }

  if (blocks.length < 3) return fallbackExtract(html, query);

  for (let i = 0; i < Math.min(blocks.length, 20); i++) {
    const listing = extractFromBlock(blocks[i], i, query);
    if (listing && listing.price > 0) results.push(listing);
  }

  return results.length >= 2 ? results : fallbackExtract(html, query);
}

function extractFromBlock(block, index, query) {
  let title = '';
  const titlePatterns = [
    /<(?:h2|h3)[^>]*>[\s\S]*?<a[^>]*>([^<]{3,80})<\/a>/i,
    /<a[^>]*class="[^"]*(?:title|name|product)[^"]*"[^>]*>([^<]{3,80})<\/a>/i,
    /<(?:h2|h3)[^>]*>([^<]{3,80})<\/(?:h2|h3)>/i,
    /data-title="([^"]{3,80})"/i
  ];
  for (const p of titlePatterns) {
    const hit = block.match(p);
    if (hit && hit[1].trim().length > 2) { title = hit[1].trim(); break; }
  }

  let price = 0;
  const pricePatterns = [
    /€\s*([\d]{1,3}(?:[.,]\d{3})+)/,
    /€\s*([\d]{2,6})/,
    /data-price="([\d.,]+)"/i
  ];
  for (const p of pricePatterns) {
    const hit = block.match(p);
    if (hit) {
      const val = Math.round(parseFloat(hit[1].replace(/\./g, '').replace(',', '.')));
      if (val >= 200 && val <= 2000000) { price = val; break; }
    }
  }

  let year = 0;
  const yearMatch = block.match(/\b(19[89]\d|200\d|201\d|202[0-6])\b/);
  if (yearMatch) year = parseInt(yearMatch[1]);

  let hours = 0;
  const hoursMatch = block.match(/(\d[\d.]*)\s*(?:uur|uren|u\b|h\b|bedrijfsuren)/i);
  if (hoursMatch) hours = parseInt(hoursMatch[1].replace(/\./g, ''));

  let region = 'NL';
  const regionMatch = block.match(/(?:class="[^"]*(?:location|locatie|place)[^"]*"[^>]*>)([^<]{2,40})/i);
  if (regionMatch) region = regionMatch[1].trim();

  let sourceUrl = '';
  const urlPatterns = [
    /href="(https?:\/\/www\.machineseeker\.nl\/[^"?#]{10,})"/,
    /href="(\/[^"]*\/\d{4,}[^"]*)"/
  ];
  for (const p of urlPatterns) {
    const hit = block.match(p);
    if (hit) {
      sourceUrl = hit[1].startsWith('http') ? hit[1] : 'https://www.machineseeker.nl' + hit[1];
      break;
    }
  }

  if (!title && price === 0) return null;

  const { brand, model } = splitTitle(title || query);
  return {
    id: `ms_live_${Date.now()}_${index}`,
    brand, model,
    fullTitle: title || query,
    price, year, hours,
    condition: '\u2014',
    region,
    source: 'machineseeker',
    source_url: sourceUrl,
    estimatedResale: 0,
    external: true,
    liveResult: true
  };
}

function fallbackExtract(html, query) {
  const results = [];
  const { brand, model } = splitTitle(query);
  const prices = [];
  const urls = [];
  let m;

  const priceRe = /€\s*([\d]{1,3}(?:\.\d{3})*)/g;
  while ((m = priceRe.exec(html)) !== null) {
    const val = parseInt(m[1].replace(/\./g, ''));
    if (val >= 500 && val <= 1000000 && !prices.includes(val)) prices.push(val);
  }

  const urlRe = /href="(\/[^"]*\/\d{5,}[^"]*)"/g;
  while ((m = urlRe.exec(html)) !== null) {
    const url = 'https://www.machineseeker.nl' + m[1];
    if (!urls.includes(url)) urls.push(url);
  }

  const count = Math.min(prices.length, urls.length, 15);
  for (let i = 0; i < count; i++) {
    results.push({
      id: `ms_fb_${Date.now()}_${i}`,
      brand, model,
      fullTitle: query,
      price: prices[i], year: 0, hours: 0,
      condition: '\u2014', region: 'NL',
      source: 'machineseeker',
      source_url: urls[i],
      estimatedResale: 0,
      external: true, liveResult: true
    });
  }
  return results;
}

function splitTitle(title) {
  const knownBrands = [
    'Toyota', 'Linde', 'Still', 'Jungheinrich', 'Nissan', 'Manitou',
    'JLG', 'Genie', 'Haulotte', 'Skyjack', 'Hyster', 'Yale', 'Crown',
    'Bobcat', 'JCB', 'Merlo', 'Niftylift', 'Dingli', 'Caterpillar', 'CAT',
    'Komatsu', 'Kubota', 'Doosan', 'Mitsubishi', 'Hyundai'
  ];

  if (!title) return { brand: '\u2014', model: '\u2014' };
  const clean = title.trim();

  for (const b of knownBrands) {
    if (clean.toLowerCase().startsWith(b.toLowerCase())) {
      return { brand: b, model: clean.substring(b.length).trim() || clean };
    }
  }

  const parts = clean.split(/\s+/);
  return { brand: parts[0] || '\u2014', model: parts.slice(1).join(' ') || clean };
}

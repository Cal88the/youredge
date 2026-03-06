const http = require('http');
const puppeteer = require('puppeteer-core');

const PORT = 3001;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let browser = null;
let bearerToken = null;

function stripCity(addr) {
  return addr
    .replace(/,\s*(Toronto|Mississauga|Oakville|Etobicoke|North York|Scarborough|Markham|Richmond Hill|Vaughan|Brampton|Burlington|Hamilton|Oshawa|Whitby|Ajax|Pickering|Milton|Newmarket|Aurora|Barrie|Thornhill|York)\s*$/i, '')
    .replace(/,?\s*(ON|Ontario|Canada)\b/gi, '')
    .replace(/\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d\s*$/i, '') // strip postal code
    .replace(/,\s*$/, '')
    .trim();
}

async function init() {
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    console.log('Connected to Chrome');
  } catch (e) {
    console.error('Could not connect to Chrome on port 9222. Run: bash launch-chrome.sh');
    process.exit(1);
  }

  // Get Bearer token
  const page = await browser.newPage();
  const reqHandler = req => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer') && !bearerToken) bearerToken = auth;
    req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', reqHandler);
  await page.goto('https://housesigma.com/app/on/home', { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(2000);
  page.off('request', reqHandler);
  await page.setRequestInterception(false);
  await page.close();

  if (!bearerToken) {
    console.error('Could not get HouseSigma auth token. Make sure you are logged in.');
    process.exit(1);
  }
  console.log('HouseSigma auth token acquired');
}

async function enrichAddress(address) {
  const searchAddr = stripCity(address);
  console.log(`Enriching: "${address}" -> search: "${searchAddr}"`);

  const page = await browser.newPage();
  try {
    await page.goto('https://housesigma.com/app/on/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await wait(800);

    // Step 1: API search
    const searchResult = await page.evaluate(async (addr, token) => {
      const res = await fetch('https://housesigma.com/bkv2/api/search/address_v2/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: JSON.stringify({ search_term: addr, province: 'ON', lang: 'en_US' })
      });
      return await res.json();
    }, searchAddr, bearerToken);

    const houses = searchResult.data?.house_list || [];
    const places = searchResult.data?.place_list || [];

    if (houses.length === 0 && places.length === 0) {
      return { success: false, error: 'Address not found in HouseSigma' };
    }

    // Score matches
    const addrParts = searchAddr.toLowerCase().split(/[\s,]+/).filter(p => p.length > 1);
    let bestHouse = null, bestScore = -1;

    if (places.length > 0) {
      const placeId = places[0].id;
      const match = houses.find(h => h.id_listing === placeId);
      if (match) {
        const text = places[0].text.toLowerCase();
        let score = 0;
        for (const p of addrParts) { if (text.includes(p)) score++; }
        bestHouse = match; bestScore = score;
      }
    }
    for (const house of houses) {
      const houseAddr = (house.address || house.addr || '').toLowerCase();
      let score = 0;
      for (const p of addrParts) { if (houseAddr.includes(p)) score++; }
      if (score > bestScore) { bestScore = score; bestHouse = house; }
    }
    if (!bestHouse && houses.length > 0) bestHouse = houses[0];
    if (!bestHouse && places.length > 0) {
      bestHouse = { id_listing: places[0].id, address: places[0].text?.split(',')[0] };
      bestScore = addrParts.length;
    }
    if (!bestHouse) return { success: false, error: 'No matching property found' };

    // Collect API data
    const apiData = {
      full_address: bestHouse.address || bestHouse.addr,
      property_type: bestHouse.type_text,
      bedrooms: bestHouse.bedroom_string || (bestHouse.rooms_text?.match(/(\d+)\s*Bedroom/)?.[1]),
      bathrooms: bestHouse.washroom || (bestHouse.rooms_text?.match(/(\d+)\s*Bathroom/)?.[1]),
      garage: bestHouse.garage || (bestHouse.rooms_text?.match(/(\d+)\s*Garage/)?.[1]),
      community: bestHouse.community_name,
      municipality: bestHouse.municipality_name,
      list_price: bestHouse.price,
      sold_price: bestHouse.price_sold,
      sold_date: bestHouse.date_preview,
      status: bestHouse.list_status?.text,
      lat: bestHouse.location?.lat,
      lng: bestHouse.location?.lon,
      photo_url: bestHouse.photo_url,
    };

    // Step 2: Load property page
    await page.goto(`https://housesigma.com/app/on/listing/${bestHouse.id_listing}`, { waitUntil: 'networkidle0', timeout: 25000 });

    let pageReady = false;
    for (let i = 0; i < 10; i++) {
      await wait(1000);
      const ok = await page.evaluate(() => {
        const b = document.body.innerText;
        return b.includes('Property Type:') || b.includes('Building Age:') || b.includes('Tax:');
      });
      if (ok) { pageReady = true; break; }
    }

    let pageData = {};
    if (pageReady) {
      pageData = await page.evaluate(() => {
        const body = document.body.innerText;
        const r = {};
        const patterns = {
          property_type: /Property Type:\n(.+?)(?:\n|$)/,
          style: /Style:\n(.+?)(?:\n|$)/,
          size: /Size:\n([\d,\-]+\s*(?:feet²|acres?))/,
          lot_size: /Lot Size:\n(.+?)(?:\n|$)/,
          lot_front: /Lot Front:\n(.+?)(?:\n|$)/,
          lot_depth: /Lot Depth:\n(.+?)(?:\n|$)/,
          building_age: /Building Age:\n(.+?)(?:\n|$)/,
          construction: /Construction:\n(.+?)(?:\n|$)/,
          basement: /Basement:\n(.+?)(?:\n|$)/,
          heating_type: /Heating Type:\n(.+?)(?:\n|$)/,
          cooling: /Cooling:\n(.+?)(?:\n|$)/,
          parking: /Parking:\n(.+?)(?:\n|$)/,
          storeys: /Storeys:\n(.+?)(?:\n|$)/,
          tax: /Tax:\n\$([\d,]+)/,
          estimated_value: /SigmaEstimate\s*\n?\$?([\d,]+)/,
          estimated_rent: /Estimated Rent\s*\n?\$?([\d,]+)/,
          sold_price: /Sold:\s*\$\s*([\d,]+)/,
          list_price: /Listed:\s*\$\s*([\d,]+)/,
          sold_date: /Sold in\s+(.+?)(?:\n|$)/,
          community: /Community:\n(.+?)(?:\n|$)/,
          municipality: /Municipality:\n(.+?)(?:\n|$)/,
          maintenance: /Maintenance:\n\$([\d,]+)/,
          cross_street: /Cross Street:\n(.+?)(?:\n|$)/,
          days_on_market: /Days on Market:\n(.+?)(?:\n|$)/,
        };
        for (const [k, re] of Object.entries(patterns)) {
          const m = body.match(re); if (m) r[k] = m[1].trim();
        }
        const title = document.title.match(/^(.+?),\s*(.*?)\s*(?:Sold|For Sale|Listing|Leased|History)/i);
        if (title) {
          r.full_address = title[1].trim();
          r.city = title[2].trim();
          const postal = r.city.match(/([A-Z]\d[A-Z]\s*\d[A-Z]\d)/);
          if (postal) r.postal_code = postal[1];
        }
        if (r.lot_front && r.lot_depth) r.lot_dimensions = r.lot_front + ' x ' + r.lot_depth;
        return r;
      });
    }

    // Merge
    const merged = { ...apiData };
    for (const [key, val] of Object.entries(pageData)) {
      if (val && val !== '-' && val !== 'N/A') merged[key] = val;
    }

    // Map to CRM enrichment format
    const yearBuilt = merged.building_age ? parseAgeToYear(merged.building_age) : null;
    const homeValue = merged.estimated_value ? '$' + merged.estimated_value :
                      merged.sold_price ? '$' + merged.sold_price :
                      merged.list_price ? '$' + merged.list_price : null;
    const sqft = merged.size ? parseInt(merged.size.replace(/[^\d]/g, '')) || merged.size : null;

    const enrichment = {
      year_built: yearBuilt,
      home_value: homeValue,
      property_type: merged.property_type || merged.style || null,
      sqft: sqft,
      storeys: merged.storeys ? parseInt(merged.storeys) || merged.storeys : null,
      lot_size: merged.lot_size || merged.lot_dimensions || null,
      last_sale: merged.sold_date || null,
      last_sale_price: merged.sold_price ? '$' + merged.sold_price : null,
      neighbourhood: merged.community || null,
      estimated_roof_age: yearBuilt ? estimateRoofAge(yearBuilt) : null,
      // Additional data from HouseSigma
      bedrooms: merged.bedrooms,
      bathrooms: merged.bathrooms,
      garage: merged.garage,
      construction: merged.construction,
      basement: merged.basement,
      heating: merged.heating_type,
      cooling: merged.cooling,
      parking: merged.parking,
      tax: merged.tax ? '$' + merged.tax : null,
      estimated_rent: merged.estimated_rent ? '$' + merged.estimated_rent + '/mo' : null,
      municipality: merged.municipality,
      cross_street: merged.cross_street,
      postal_code: merged.postal_code || null,
      photo_url: merged.photo_url,
      source_url: `https://housesigma.com/app/on/listing/${bestHouse.id_listing}`,
    };

    const fieldCount = Object.values(enrichment).filter(v => v && v !== 'null').length;
    console.log(`  Done: ${fieldCount} fields | ${enrichment.property_type} | ${enrichment.home_value || 'no value'}`);

    return { success: true, enrichment, fieldCount };

  } finally {
    await page.close();
  }
}

function parseAgeToYear(ageStr) {
  const currentYear = new Date().getFullYear();
  if (/new/i.test(ageStr)) return currentYear - 2;
  if (/0-5/i.test(ageStr)) return currentYear - 3;
  if (/6-10/i.test(ageStr)) return currentYear - 8;
  if (/11-15/i.test(ageStr)) return currentYear - 13;
  if (/16-30/i.test(ageStr)) return currentYear - 23;
  if (/31-50/i.test(ageStr)) return currentYear - 40;
  if (/51-99/i.test(ageStr)) return currentYear - 65;
  if (/100/i.test(ageStr)) return currentYear - 110;
  return null;
}

function estimateRoofAge(yearBuilt) {
  const age = new Date().getFullYear() - yearBuilt;
  // Assume roof replaced every 25 years
  const roofAge = age % 25;
  if (roofAge > 20) return '20+ yrs';
  if (roofAge > 15) return '~' + roofAge + ' yrs';
  if (roofAge > 10) return '~' + roofAge + ' yrs';
  return '~' + roofAge + ' yrs';
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/enrich') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { address } = JSON.parse(body);
        if (!address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'address required' }));
          return;
        }
        const result = await enrichAddress(address);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('Enrichment error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasToken: !!bearerToken }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

init().then(() => {
  server.listen(PORT, () => {
    console.log(`\nEnrichment API running at http://localhost:${PORT}`);
    console.log('Endpoints:');
    console.log('  POST /enrich  { "address": "78 Brookside Ave, Toronto" }');
    console.log('  GET  /health');
  });
});

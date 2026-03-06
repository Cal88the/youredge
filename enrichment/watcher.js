const puppeteer = require('puppeteer-core');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const CHECK_INTERVAL = 60000; // 60 seconds
const CRM_URL_MATCH = 'samplecrm';

function stripCity(addr) {
  return addr
    .replace(/,\s*(Toronto|Mississauga|Oakville|Etobicoke|North York|Scarborough|Markham|Richmond Hill|Vaughan|Brampton|Burlington|Hamilton|Oshawa|Whitby|Ajax|Pickering|Milton|Newmarket|Aurora|Barrie|Thornhill|York)\s*$/i, '')
    .replace(/,?\s*(ON|Ontario|Canada)\b/gi, '')
    .replace(/\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
}

let browser = null;
let bearerToken = null;

async function connect() {
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  console.log('[watcher] Connected to Chrome');
}

async function getBearerToken() {
  const page = await browser.newPage();
  const handler = req => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer') && !bearerToken) bearerToken = auth;
    req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', handler);
  await page.goto('https://housesigma.com/app/on/home', { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(2000);
  page.off('request', handler);
  await page.setRequestInterception(false);
  await page.close();
  if (!bearerToken) throw new Error('Could not get HouseSigma auth token');
  console.log('[watcher] HouseSigma token acquired');
}

async function findCRMPage() {
  const pages = await browser.pages();
  return pages.find(p => p.url().includes(CRM_URL_MATCH));
}

async function getUnenrichedLeads(crmPage) {
  return await crmPage.evaluate(() => {
    if (typeof leads === 'undefined') return [];
    return leads
      .filter(l => l.address && !l.enrichment)
      .map(l => ({ id: l.id, address: l.address }));
  });
}

async function enrichAddress(searchAddr) {
  const page = await browser.newPage();
  try {
    await page.goto('https://housesigma.com/app/on/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await wait(800);

    // API search
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
    if (houses.length === 0 && places.length === 0) return null;

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
    }
    if (!bestHouse) return null;

    // API data
    const apiData = {
      property_type: bestHouse.type_text,
      bedrooms: bestHouse.bedroom_string,
      bathrooms: bestHouse.washroom,
      garage: bestHouse.garage,
      neighbourhood: bestHouse.community_name,
      municipality: bestHouse.municipality_name,
      last_sale: bestHouse.date_preview,
      last_sale_price: bestHouse.price_sold ? '$' + bestHouse.price_sold : null,
      photo_url: bestHouse.photo_url,
    };

    // Load property page for full details
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
        const pats = {
          property_type: /Property Type:\n(.+?)(?:\n|$)/,
          style: /Style:\n(.+?)(?:\n|$)/,
          size: /Size:\n([\d,\-]+\s*(?:feet²|acres?))/,
          lot_size: /Lot Size:\n(.+?)(?:\n|$)/,
          building_age: /Building Age:\n(.+?)(?:\n|$)/,
          construction: /Construction:\n(.+?)(?:\n|$)/,
          basement: /Basement:\n(.+?)(?:\n|$)/,
          heating: /Heating Type:\n(.+?)(?:\n|$)/,
          cooling: /Cooling:\n(.+?)(?:\n|$)/,
          parking: /Parking:\n(.+?)(?:\n|$)/,
          tax: /Tax:\n\$([\d,]+)/,
          estimated_value: /SigmaEstimate\s*\n?\$?([\d,]+)/,
          estimated_rent: /Estimated Rent\s*\n?\$?([\d,]+)/,
          sold_price: /Sold:\s*\$\s*([\d,]+)/,
          list_price: /Listed:\s*\$\s*([\d,]+)/,
          sold_date: /Sold in\s+(.+?)(?:\n|$)/,
          cross_street: /Cross Street:\n(.+?)(?:\n|$)/,
        };
        for (const [k, re] of Object.entries(pats)) {
          const m = body.match(re); if (m) r[k] = m[1].trim();
        }
        const t = document.title.match(/^(.+?),\s*(.*?)\s*(?:Sold|For Sale|Listing|Leased|History)/i);
        if (t) {
          r.full_address = t[1].trim();
          const postal = t[2].match(/([A-Z]\d[A-Z]\s*\d[A-Z]\d)/);
          if (postal) r.postal_code = postal[1];
        }
        return r;
      });
    }

    // Merge and format for CRM
    const merged = { ...apiData, ...pageData };
    const yearBuilt = parseAge(merged.building_age);
    const homeValue = merged.estimated_value ? '$' + merged.estimated_value :
                      merged.sold_price ? '$' + merged.sold_price :
                      merged.list_price ? '$' + merged.list_price : null;

    return {
      year_built: yearBuilt,
      home_value: homeValue,
      property_type: merged.property_type || null,
      sqft: merged.size ? merged.size.replace(/feet²/, 'sqft') : null,
      lot_size: merged.lot_size || null,
      last_sale: merged.sold_date || merged.last_sale || null,
      last_sale_price: merged.last_sale_price || (merged.sold_price ? '$' + merged.sold_price : null),
      neighbourhood: merged.neighbourhood || null,
      estimated_roof_age: yearBuilt ? roofAge(yearBuilt) : null,
      bedrooms: merged.bedrooms,
      bathrooms: merged.bathrooms,
      construction: merged.construction,
      basement: merged.basement,
      heating: merged.heating,
      cooling: merged.cooling,
      parking: merged.parking,
      tax: merged.tax ? '$' + merged.tax : null,
      estimated_rent: merged.estimated_rent ? '$' + merged.estimated_rent + '/mo' : null,
    };
  } finally {
    await page.close();
  }
}

function parseAge(s) {
  if (!s) return null;
  const y = new Date().getFullYear();
  if (/new/i.test(s)) return y - 2;
  if (/0-5/.test(s)) return y - 3;
  if (/6-10/.test(s)) return y - 8;
  if (/11-15/.test(s)) return y - 13;
  if (/16-30/.test(s)) return y - 23;
  if (/31-50/.test(s)) return y - 40;
  if (/51-99/.test(s)) return y - 65;
  if (/100/.test(s)) return y - 110;
  return null;
}

function roofAge(yearBuilt) {
  const age = (new Date().getFullYear() - yearBuilt) % 25;
  return age > 20 ? '20+ yrs' : '~' + age + ' yrs';
}

async function tick() {
  try {
    const crmPage = await findCRMPage();
    if (!crmPage) return;

    const unenriched = await getUnenrichedLeads(crmPage);
    if (!unenriched.length) return;

    console.log(`[watcher] Found ${unenriched.length} lead(s) to enrich`);

    for (const lead of unenriched) {
      const searchAddr = stripCity(lead.address);
      console.log(`[watcher] Enriching "${lead.address}" -> "${searchAddr}"`);

      try {
        const data = await enrichAddress(searchAddr);
        if (data) {
          // Inject enrichment data directly into the CRM page
          await crmPage.evaluate((leadId, enrichment) => {
            const lead = leads.find(l => l.id === leadId);
            if (lead) {
              lead.enrichment = enrichment;
              // Re-render the enrichment panel for this lead
              const container = document.getElementById('enrich-' + leadId);
              if (container) container.innerHTML = buildEnrichmentContent(lead);
            }
          }, lead.id, data);

          const fields = Object.values(data).filter(v => v && v !== 'null').length;
          console.log(`[watcher]   Done: ${fields} fields | ${data.property_type || '?'} | ${data.home_value || '?'}`);
        } else {
          // Mark as attempted so we don't retry endlessly
          await crmPage.evaluate((leadId) => {
            const lead = leads.find(l => l.id === leadId);
            if (lead) lead.enrichment = { _notFound: true };
          }, lead.id);
          console.log(`[watcher]   No data found for this address`);
        }
      } catch (e) {
        console.log(`[watcher]   Error: ${e.message}`);
      }

      await wait(1000); // pace between lookups
    }
  } catch (e) {
    if (e.message.includes('detached') || e.message.includes('closed')) {
      console.log('[watcher] CRM page closed or navigated away — will retry next cycle');
    } else {
      console.log('[watcher] Error:', e.message);
    }
  }
}

(async () => {
  await connect();
  await getBearerToken();

  console.log(`[watcher] Running — checking every ${CHECK_INTERVAL/1000}s for new leads`);
  console.log('[watcher] Open the CRM in Chrome and add a lead with an address\n');

  // Run immediately, then on interval
  await tick();
  setInterval(tick, CHECK_INTERVAL);
})().catch(e => {
  console.error('[watcher] Fatal:', e.message);
  process.exit(1);
});

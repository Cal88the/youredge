const puppeteer = require('puppeteer-core');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const address = process.argv[2];
if (!address) {
  console.error('Usage: node enrich-v3.js "78 Brookside Ave"');
  console.error('NOTE: Do NOT include city/province — just street address');
  process.exit(1);
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  } catch (e) {
    console.error('Could not connect to Chrome. Run: bash launch-chrome.sh');
    process.exit(1);
  }

  const page = await browser.newPage();

  try {
    // Step 1: Load HouseSigma to grab Bearer token
    console.log('Step 1: Connecting to HouseSigma...');
    // Grab Bearer token by intercepting initial page load requests
    let bearerToken = null;
    const reqHandler = req => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer') && !bearerToken) bearerToken = auth;
      req.continue();
    };
    await page.setRequestInterception(true);
    page.on('request', reqHandler);

    await page.goto('https://housesigma.com/app/on/home', { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    // Stop intercepting before navigating again
    page.off('request', reqHandler);
    await page.setRequestInterception(false);

    if (!bearerToken) {
      console.error('Could not get auth token. Make sure you are logged into HouseSigma.');
      process.exit(1);
    }
    console.log('  Auth token acquired');

    // Step 2: Search via API (strip city/province from input)
    // Strip city/province but only after a comma or at end, to avoid mangling street names like "Rushton"
    const searchAddr = address
      .replace(/,\s*(Toronto|Mississauga|Oakville|Etobicoke|North York|Scarborough|Markham|Richmond Hill|Vaughan|Brampton|Burlington|Hamilton|Oshawa|Whitby|Ajax|Pickering|Milton|Newmarket|Aurora|Barrie|Thornhill)\s*$/i, '')
      .replace(/,\s*(ON|Ontario|Canada)\s*$/i, '')
      .replace(/,\s*$/, '')
      .trim();

    console.log(`\nStep 2: Searching API for "${searchAddr}"...`);

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
      console.error('  No results found for this address.');
      process.exit(1);
    }

    console.log(`  Found ${houses.length} listings, ${places.length} places`);

    // Score houses against the input address to find best match
    const addrLower = searchAddr.toLowerCase();
    const addrParts = addrLower.split(/[\s,]+/).filter(p => p.length > 1);

    let bestHouse = null;
    let bestScore = -1;

    // Use place_list first — it gives the exact address match
    if (places.length > 0) {
      const placeText = places[0].text.toLowerCase();
      let score = 0;
      for (const part of addrParts) {
        if (placeText.includes(part)) score++;
      }
      // Find the matching house by id
      const placeId = places[0].id;
      bestHouse = houses.find(h => h.id_listing === placeId);
      if (bestHouse) bestScore = score;
    }

    // Also try scoring all houses
    for (const house of houses) {
      const houseAddr = (house.address || house.addr || '').toLowerCase();
      let score = 0;
      for (const part of addrParts) {
        if (houseAddr.includes(part)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestHouse = house;
      }
    }

    if (!bestHouse && houses.length > 0) bestHouse = houses[0];

    // If no house found but we have a place, use the place ID
    if (!bestHouse && places.length > 0) {
      bestHouse = {
        id_listing: places[0].id,
        address: places[0].text?.split(',')[0],
        community_name: places[0].text?.match(/- (.+?), ON/)?.[1],
        municipality_name: places[0].text?.match(/, (.+?) -/)?.[1],
        type_text: null,
        seo_municipality: places[0].seo_municipality,
      };
      bestScore = addrParts.length; // place match is exact
    }

    if (!bestHouse) {
      console.error('  Could not find a matching property.');
      process.exit(1);
    }

    const matchedAddr = bestHouse.address || bestHouse.addr || places[0]?.text || 'Unknown';
    console.log(`  Best match: ${matchedAddr} (score: ${bestScore}/${addrParts.length})`);

    // Step 3: Extract what we can from the API response
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
      id_listing: bestHouse.id_listing,
    };

    console.log(`\n  API data: ${apiData.property_type} | ${apiData.bedrooms}bd/${apiData.bathrooms}ba | ${apiData.community}`);

    // Step 4: Navigate to property page for detailed data
    console.log('\nStep 3: Loading property page for full details...');
    const propertyUrl = `https://housesigma.com/app/on/listing/${bestHouse.id_listing}`;

    await page.goto(propertyUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for the SPA to render property data — try multiple selectors
    let pageReady = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await wait(1500);
      const hasData = await page.evaluate(() => {
        const body = document.body.innerText;
        // Check for any of these property page indicators
        return body.includes('Property Type:') ||
               body.includes('Building Age:') ||
               body.includes('Bedrooms') ||
               body.includes('SigmaEstimate') ||
               body.includes('Tax:') ||
               document.querySelector('[class*="listing-detail"]') !== null ||
               document.querySelector('[class*="house-detail"]') !== null;
      });
      if (hasData) { pageReady = true; break; }
      if (attempt === 5) console.log('  Still waiting for page to render...');
    }

    let pageData = {};
    if (pageReady) {
      console.log('  Property page loaded');
      pageData = await page.evaluate(() => {
        const body = document.body.innerText;
        const r = {};

        // HouseSigma uses "Label:\nValue" format with newlines
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
          heating_fuel: /Heating Fuel:\n(.+?)(?:\n|$)/,
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
          listing_brokerage: /Listing Brokerage:\n(.+?)(?:\n|$)/,
          lot_irregularities: /Lot Irregularities:\n(.+?)(?:\n|$)/,
          listed_on: /Listed on:\n(.+?)(?:\n|$)/,
          data_source: /Data Source:\n(.+?)(?:\n|$)/,
        };

        // Also try "Label:\s*Value" format (some fields use this)
        const altPatterns = {
          property_type: /Property Type:\s+(.+?)(?:\n|$)/,
          building_age: /Building Age:\s+(.+?)(?:\n|$)/,
          tax: /Tax:\s*\$([\d,]+)/,
          sold_price: /Sold:\s*\$\s*([\d,]+)/,
          list_price: /Listed:\s*\$\s*([\d,]+)/,
        };

        for (const [k, re] of Object.entries(patterns)) {
          const m = body.match(re);
          if (m) r[k] = m[1].trim();
        }
        // Fill gaps with alt patterns
        for (const [k, re] of Object.entries(altPatterns)) {
          if (!r[k]) {
            const m = body.match(re);
            if (m) r[k] = m[1].trim();
          }
        }

        // Title-based address + postal code
        const title = document.title.match(/^(.+?),\s*(.*?)\s*(?:Sold|For Sale|Listing|Leased|History)/i);
        if (title) {
          r.full_address = title[1].trim();
          r.city_province_postal = title[2].trim();
          // Extract postal code
          const postalMatch = r.city_province_postal.match(/([A-Z]\d[A-Z]\s*\d[A-Z]\d)/);
          if (postalMatch) r.postal_code = postalMatch[1];
        }

        // Description
        const descMatch = body.match(/Description:\n([\s\S]*?)(?:\n\n|\nKey Facts|\nDetails|\nListing #)/);
        if (descMatch) r.description = descMatch[1].trim().substring(0, 500);

        if (r.lot_front && r.lot_depth) {
          r.lot_dimensions = r.lot_front + ' x ' + r.lot_depth;
        }

        return r;
      });
      console.log(`  Page fields extracted: ${Object.keys(pageData).length}`);
    } else {
      console.log('  Property page did not fully load — using API data only');
    }

    // Step 5: Merge API data + page data (page data takes priority for overlapping fields)
    const merged = { ...apiData };
    for (const [key, val] of Object.entries(pageData)) {
      if (val && val !== '-' && val !== 'N/A') {
        merged[key] = val;
      }
    }
    merged.source_url = propertyUrl;

    // Print results
    console.log('\n========== ENRICHMENT RESULTS ==========\n');
    const fields = [
      ['Address', merged.full_address],
      ['City', merged.city || merged.municipality],
      ['Property Type', merged.property_type],
      ['Style', merged.style],
      ['Size (sqft)', merged.size],
      ['Lot Size', merged.lot_size || merged.lot_dimensions],
      ['Bedrooms', merged.bedrooms],
      ['Bathrooms', merged.bathrooms],
      ['Garage', merged.garage],
      ['Storeys', merged.storeys],
      ['Building Age', merged.building_age],
      ['Construction', merged.construction],
      ['Basement', merged.basement_type],
      ['Heating', merged.heating_type],
      ['Cooling', merged.cooling],
      ['Parking', merged.parking],
      ['Sold Price', merged.sold_price ? '$' + merged.sold_price : null],
      ['List Price', merged.list_price ? '$' + merged.list_price : null],
      ['Sold Date', merged.sold_date],
      ['Status', merged.status],
      ['Estimated Value', merged.estimated_value ? '$' + merged.estimated_value : null],
      ['Estimated Rent', merged.estimated_rent ? '$' + merged.estimated_rent + '/mo' : null],
      ['Tax', merged.tax ? '$' + merged.tax + '/yr' : null],
      ['Community', merged.community],
      ['Municipality', merged.municipality],
      ['Cross Street', merged.cross_street],
      ['Postal Code', merged.postal_code],
      ['Days on Market', merged.days_on_market],
      ['Listed On', merged.listed_on],
    ];

    let found = 0;
    for (const [label, val] of fields) {
      if (val && val !== '-') {
        console.log(`  ${label}: ${val}`);
        found++;
      }
    }
    console.log(`\n  Fields found: ${found}/${fields.length}`);
    console.log(`  Source: ${merged.source_url}`);

    console.log('\n=== RAW JSON ===\n');
    console.log(JSON.stringify(merged, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await page.close();
    browser.disconnect();
  }
})();

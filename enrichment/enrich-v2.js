const puppeteer = require('puppeteer-core');
const https = require('https');
const http = require('http');

const address = process.argv[2];
if (!address) {
  console.error('Usage: node enrich-v2.js "78 Brookside Ave, Toronto ON"');
  process.exit(1);
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Step 1: Geocode via OpenStreetMap Nominatim (free, no key needed)
function geocode(addr) {
  return new Promise((resolve, reject) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr + ', Canada')}&format=json&addressdetails=1&limit=1`;
    https.get(url, { headers: { 'User-Agent': 'YourEdge-Enrichment/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0) {
            resolve({
              lat: parseFloat(results[0].lat),
              lng: parseFloat(results[0].lon),
              display: results[0].display_name,
              address: results[0].address
            });
          } else {
            resolve(null);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  // Step 1: Geocode
  console.log('Step 1: Geocoding address...');
  const geo = await geocode(address);
  if (!geo) {
    console.error('Could not geocode address:', address);
    process.exit(1);
  }
  console.log(`  Found: ${geo.display}`);
  console.log(`  Coords: ${geo.lat}, ${geo.lng}`);
  const neighbourhood = geo.address.city_block || geo.address.neighbourhood || geo.address.suburb || geo.address.quarter || '';
  if (neighbourhood) console.log(`  Neighbourhood: ${neighbourhood}`);

  // Step 2: Connect to Chrome
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  } catch (e) {
    console.error('Could not connect to Chrome. Run: bash launch-chrome.sh');
    process.exit(1);
  }

  const page = await browser.newPage();

  try {
    // Step 2: Navigate HouseSigma map to exact coordinates
    console.log('\nStep 2: Loading HouseSigma map at coordinates...');
    const mapUrl = `https://housesigma.com/app/on/home?lat=${geo.lat}&lng=${geo.lng}&zoom=19&list=1`;
    await page.goto(mapUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await wait(3000);

    // Step 3: Try to find property via search with the geocoded address
    console.log('Step 3: Searching for property...');
    const input = await page.$('.input-area input');
    if (input) {
      await input.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await wait(300);

      // Use the standardized address from geocoding for better matching
      const searchAddr = address.replace(/\s+ON\b/i, '').replace(/\s+Canada\b/i, '');
      await input.type(searchAddr, { delay: 40 });
      await wait(3000);

      // Check for listings in search results
      const searchResult = await page.evaluate(() => {
        const result = document.querySelector('.search-result');
        if (!result) return { found: false };
        const allLinks = Array.from(result.querySelectorAll('a[href*="/home/"]'));
        return {
          found: allLinks.length > 0,
          listings: allLinks.slice(0, 5).map(a => ({
            href: a.href,
            text: a.textContent.trim().substring(0, 150)
          }))
        };
      });

      if (searchResult.found) {
        // Score matches against our address
        const addrLower = searchAddr.toLowerCase();
        const addrParts = addrLower.split(/[\s,]+/).filter(p => p.length > 1 && !['on','toronto','ontario','canada'].includes(p));

        let bestMatch = searchResult.listings[0];
        let bestScore = 0;
        for (const listing of searchResult.listings) {
          const t = listing.text.toLowerCase();
          let score = 0;
          for (const part of addrParts) { if (t.includes(part)) score++; }
          if (score > bestScore) { bestScore = score; bestMatch = listing; }
        }

        console.log(`  Search match: ${bestMatch.text.substring(0, 80)} (score: ${bestScore}/${addrParts.length})`);

        // Only use if it's a decent match
        if (bestScore >= Math.max(2, addrParts.length - 1)) {
          console.log('\nStep 4: Loading property page...');
          await page.goto(bestMatch.href, { waitUntil: 'networkidle2', timeout: 25000 });
          await wait(3000);
        } else {
          console.log('  Weak match — trying map pin click instead...');
          await tryMapClick(page, geo);
        }
      } else {
        console.log('  No search results — trying map pin click...');
        await tryMapClick(page, geo);
      }
    }

    // Step 5: Extract data from whatever page we landed on
    console.log('\nStep 5: Extracting property data...');
    const data = await extractPropertyData(page);
    data.geocoded_neighbourhood = neighbourhood;
    data.geocoded_lat = geo.lat;
    data.geocoded_lng = geo.lng;

    // Print results
    console.log('\n========== ENRICHMENT RESULTS ==========\n');
    const fields = [
      ['Address', data.full_address],
      ['City', data.city_province],
      ['Property Type', data.property_type],
      ['Style', data.style],
      ['Size', data.size],
      ['Lot Size', data.lot_size || data.lot_dimensions],
      ['Bedrooms', data.bedrooms],
      ['Bathrooms', data.bathrooms],
      ['Storeys', data.storeys],
      ['Building Age', data.building_age],
      ['Construction', data.construction],
      ['Basement', data.basement_type],
      ['Sold Price', data.sold_price ? '$' + data.sold_price : null],
      ['List Price', data.list_price ? '$' + data.list_price : null],
      ['Sold Date', data.sold_date],
      ['Estimated Value', data.estimated_value ? '$' + data.estimated_value : null],
      ['Estimated Rent', data.estimated_rent ? '$' + data.estimated_rent + '/mo' : null],
      ['Tax', data.tax ? '$' + data.tax + '/yr' : null],
      ['Community', data.community],
      ['Neighbourhood (geo)', neighbourhood],
      ['Municipality', data.municipality],
      ['Heating', data.heating_type],
      ['Cooling', data.cooling],
      ['Parking', data.parking_type],
      ['Parking Spaces', data.parking_spaces],
    ];

    let found = 0;
    for (const [label, val] of fields) {
      if (val && val !== '-') {
        console.log(`  ${label}: ${val}`);
        found++;
      }
    }
    console.log(`\n  Fields found: ${found}/${fields.length}`);
    console.log(`  Source: ${data.url || 'N/A'}`);

    console.log('\n=== RAW JSON ===\n');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await page.close();
    browser.disconnect();
  }
})();

async function tryMapClick(page, geo) {
  // Navigate to tight map view and try clicking near center
  console.log('  Navigating to precise map location...');
  const mapUrl = `https://housesigma.com/app/on/home?lat=${geo.lat}&lng=${geo.lng}&zoom=20&list=0`;
  await page.goto(mapUrl, { waitUntil: 'networkidle2', timeout: 25000 });
  await wait(4000);

  // Try to find and click a map marker near the center of the viewport
  const clicked = await page.evaluate(() => {
    // Look for map markers/pins
    const markers = document.querySelectorAll('.mapboxgl-marker, [class*="marker"], [class*="pin"], .map-marker');
    if (markers.length > 0) {
      markers[0].click();
      return true;
    }

    // Try clicking the center of the map canvas
    const canvas = document.querySelector('.mapboxgl-canvas, canvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const event = new MouseEvent('click', {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true
      });
      canvas.dispatchEvent(event);
      return true;
    }
    return false;
  });

  if (clicked) {
    console.log('  Clicked map — waiting for property info...');
    await wait(3000);

    // Check if a property panel opened with a link
    const propertyLink = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/home/"]');
      if (links.length > 0) return links[links.length - 1].href;
      return null;
    });

    if (propertyLink) {
      console.log('  Found property from map!');
      await page.goto(propertyLink, { waitUntil: 'networkidle2', timeout: 25000 });
      await wait(3000);
    } else {
      console.log('  No property link found from map click.');
    }
  }
}

async function extractPropertyData(page) {
  return await page.evaluate(() => {
    const body = document.body.innerText;
    const result = {};

    const titleMatch = document.title.match(/^(.+?),\s*(.*?)\s*(?:Sold|For Sale|Listing|Leased|History)/i);
    if (titleMatch) {
      result.full_address = titleMatch[1].trim();
      result.city_province = titleMatch[2].trim();
    }

    const patterns = {
      sold_price: /Sold:\s*\$\s*([\d,]+)/,
      list_price: /Listed:\s*\$\s*([\d,]+)/,
      tax: /Tax:\s*\$([\d,]+)/,
      property_type: /Property Type:\s*(.+?)(?:\n|$)/,
      maintenance: /Maintenance:\s*\$([\d,]+)/,
      building_age: /Building Age:\s*(.+?)(?:\n|$)/,
      size: /Size:\s*([\d,\-]+\s*(?:feet²|acres?))/,
      bedrooms: /([\d+]+)\s*Bedrooms/,
      bathrooms: /(\d+)\s*Bathrooms/,
      garage: /(\d+)\s*Garage/,
      community: /Community:\s*(.+?)(?:\n|$)/,
      municipality: /Municipality:\s*(.+?)(?:\n|$)/,
      style: /Style:\s*(.+?)(?:\n|$)/,
      construction: /Construction:\s*(.+?)(?:\n|$)/,
      basement_type: /Basement Type:\s*(.+?)(?:\n|$)/,
      heating_type: /Heating Type:\s*(.+?)(?:\n|$)/,
      heating_fuel: /Heating Fuel:\s*(.+?)(?:\n|$)/,
      cooling: /Cooling:\s*(.+?)(?:\n|$)/,
      parking_type: /Garage Type:\s*(.+?)(?:\n|$)/,
      parking_spaces: /Total Parking Space:\s*(.+?)(?:\n|$)/,
      lot_front: /Lot Front:\s*(.+?)(?:\n|$)/,
      lot_depth: /Lot Depth:\s*(.+?)(?:\n|$)/,
      lot_size: /Lot Size:\s*(.+?)(?:\n|$)/,
      cross_street: /Cross Street:\s*(.+?)(?:\n|$)/,
      listed_on: /Listed on:\s*(.+?)(?:\n|$)/,
      sold_date: /Sold in\s*(.+?)(?:\n|$)/,
      estimated_value: /SigmaEstimate\s*\n?\$?([\d,]+)/,
      estimated_rent: /Estimated Rent\s*\n?\$?([\d,]+)/,
      days_on_market: /Days on Market:\s*(.+?)(?:\n|$)/,
      storeys: /Storeys:\s*(.+?)(?:\n|$)/
    };

    for (const [key, regex] of Object.entries(patterns)) {
      const match = body.match(regex);
      if (match) result[key] = match[1].trim();
    }

    if (result.lot_front && result.lot_depth) {
      result.lot_dimensions = result.lot_front + ' x ' + result.lot_depth;
    }

    result.url = window.location.href;
    return result;
  });
}

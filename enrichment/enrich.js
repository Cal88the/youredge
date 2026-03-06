const puppeteer = require('puppeteer-core');

const address = process.argv[2];
if (!address) {
  console.error('Usage: node enrich.js "15 Lakeshore Blvd, Oakville ON"');
  process.exit(1);
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

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
    console.log('Searching HouseSigma for:', address);

    // Strategy: use the direct address search URL which does a better job
    const encodedAddr = encodeURIComponent(address);
    await page.goto('https://housesigma.com/app/on/home?search=' + encodedAddr, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    // Type in search bar for autocomplete
    const input = await page.$('.input-area input');
    if (!input) throw new Error('Search input not found');

    // Clear and retype to trigger fresh autocomplete
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await wait(500);
    await input.type(address, { delay: 40 });
    await wait(3000);

    // Look for results - check both address matches AND listing matches
    const searchResult = await page.evaluate(() => {
      const result = document.querySelector('.search-result');
      if (!result) return { found: false };

      const allLinks = Array.from(result.querySelectorAll('a[href*="/home/"]'));
      const listings = allLinks.map(a => ({
        href: a.href,
        text: a.textContent.trim().substring(0, 150),
        address: (a.querySelector('.listing-address') || {}).textContent || ''
      }));

      const notFound = result.querySelector('.not-found');

      return {
        found: listings.length > 0,
        addressNotFound: notFound ? true : false,
        count: listings.length,
        listings: listings.slice(0, 5)
      };
    });

    let propertyUrl = null;

    if (searchResult.found) {
      // Pick the best match - prefer one where the address text contains our search terms
      const addrLower = address.toLowerCase().replace(/[,]/g, '');
      const addrParts = addrLower.split(/\s+/).filter(p => p.length > 2);

      let bestMatch = searchResult.listings[0];
      let bestScore = 0;

      for (const listing of searchResult.listings) {
        const listText = listing.text.toLowerCase();
        let score = 0;
        for (const part of addrParts) {
          if (listText.includes(part)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = listing;
        }
      }

      propertyUrl = bestMatch.href;
      console.log('Best match:', bestMatch.text.substring(0, 100));
      console.log('Match score:', bestScore + '/' + addrParts.length);
    }

    if (!propertyUrl) {
      console.log('\nNo property found on HouseSigma for:', address);
      console.log('This address may not have a recent listing in the TRREB system.');
      await page.close();
      browser.disconnect();
      return;
    }

    // Navigate to the property page
    console.log('Loading property page...');
    await page.goto(propertyUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await wait(3000);

    // Extract all the property data
    const data = await page.evaluate(() => {
      const body = document.body.innerText;
      const result = {};

      // Address from title
      const titleMatch = document.title.match(/^(.+?),\s*(.*?)\s*(?:Sold|For Sale|Listing|Leased)/i);
      if (titleMatch) {
        result.full_address = titleMatch[1].trim();
        result.city_province = titleMatch[2].trim();
      }

      const patterns = {
        sold_price: /Sold:\s*\$\s*([\d,]+)/,
        list_price: /Listed:\s*\$\s*([\d,]+)/,
        tax: /Tax:\s*\$([\d,]+)\s*\/\s*(\d{4})/,
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

      // Build a lot_dimensions field from front x depth
      if (result.lot_front && result.lot_depth) {
        result.lot_dimensions = result.lot_front + ' x ' + result.lot_depth;
      }

      result.url = window.location.href;
      return result;
    });

    // Print results
    console.log('\n=== ENRICHMENT DATA ===\n');
    const fields = [
      'full_address', 'city_province', 'property_type', 'style', 'size',
      'bedrooms', 'bathrooms', 'storeys', 'building_age', 'construction',
      'lot_dimensions', 'lot_size',
      'sold_price', 'list_price', 'sold_date', 'estimated_value',
      'tax', 'community', 'municipality',
      'heating_type', 'cooling', 'basement_type',
      'parking_type', 'parking_spaces',
      'estimated_rent', 'days_on_market'
    ];

    for (const f of fields) {
      if (data[f]) {
        const label = f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        console.log('  ' + label + ': ' + data[f]);
      }
    }

    console.log('\n=== RAW JSON ===\n');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await page.close();
    browser.disconnect();
  }
})();

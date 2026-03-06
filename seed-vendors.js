require('dotenv').config();
const vendors = require('./vendors.json');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function slugify(name) {
  return name
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'and')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function run() {
  // Create the vendors table
  const createSQL = `
    CREATE TABLE IF NOT EXISTS vendors (
      id serial PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      category text,
      booth text,
      demo boolean DEFAULT true,
      password text,
      created_at timestamptz DEFAULT now()
    );
  `;

  console.log('Creating vendors table...');
  const sqlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify({})
  });

  // Use the SQL editor endpoint instead
  const pgRes = await fetch(`${SUPABASE_URL}/pg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify({ query: createSQL })
  });

  // Try direct REST approach - create via management API
  // Actually, let's just use the REST API to insert after creating table via SQL editor
  // First, let's try creating the table via the SQL endpoint

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=minimal'
  };

  // Prepare vendor rows
  const rows = [];
  const seenSlugs = new Set();

  for (const v of vendors) {
    let slug = slugify(v.name);
    // Handle duplicates
    if (seenSlugs.has(slug)) {
      slug = slug + '-2';
    }
    seenSlugs.add(slug);

    rows.push({
      slug,
      name: v.name,
      category: v.category,
      booth: v.booth,
      demo: true,
      password: null
    });
  }

  // Try inserting - if table doesn't exist, we'll get an error
  console.log(`Inserting ${rows.length} vendors...`);
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/vendors`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify(rows)
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    if (err.includes('relation') && err.includes('does not exist')) {
      console.log('\nTable does not exist yet. Run this SQL in the Supabase SQL Editor:\n');
      console.log(createSQL);
      console.log('\nThen run this script again.');
    } else {
      console.error('Insert error:', err);
    }
    return;
  }

  const inserted = await insertRes.json();
  console.log(`Done! Inserted ${inserted.length} vendors.`);

  // Print a few examples
  console.log('\nSample slugs:');
  inserted.slice(0, 10).forEach(v => {
    console.log(`  weareyouredge.com/${v.slug}  →  ${v.name}`);
  });
}

run().catch(e => console.error(e));

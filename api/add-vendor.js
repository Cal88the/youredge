module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var { name, category, booth, password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Vendor name is required' });
  }

  var slug = name.trim()
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'and')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug) {
    return res.status(400).json({ error: 'Vendor name produces an invalid URL. Try a different name.' });
  }

  var row = {
    slug: slug,
    name: name.trim(),
    category: (category || '').trim() || null,
    booth: (booth || '').trim() || null,
    demo: true
  };

  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendors', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!supaRes.ok) {
    var err = await supaRes.text();
    if (err.includes('duplicate') || err.includes('unique')) {
      return res.status(409).json({ error: 'A vendor with that name already exists' });
    }
    return res.status(500).json({ error: 'Failed to create vendor' });
  }

  var vendor = await supaRes.json();
  return res.status(200).json(vendor[0]);
};

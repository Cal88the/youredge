module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var { password, vendor_slug, contact_name, contact_title, contact_email, contact_phone, notes, card_photo } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (!vendor_slug) {
    return res.status(400).json({ error: 'vendor_slug is required' });
  }

  // Verify vendor exists
  var checkRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendors?slug=eq.' + encodeURIComponent(vendor_slug) + '&select=slug&limit=1', {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });
  var found = await checkRes.json();
  if (!found || !found.length) {
    return res.status(404).json({ error: 'Vendor not found' });
  }

  var row = {
    vendor_slug: vendor_slug,
    contact_name: contact_name || null,
    contact_title: contact_title || null,
    contact_email: contact_email || null,
    contact_phone: contact_phone || null,
    notes: notes || null,
    card_photo: card_photo || null,
    updated_at: new Date().toISOString()
  };

  // Upsert — insert or update on conflict
  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendor_contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'return=representation,resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });

  if (!supaRes.ok) {
    var err = await supaRes.text();
    return res.status(500).json({ error: 'Failed to save contact' });
  }

  var saved = await supaRes.json();
  return res.status(200).json(saved[0]);
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var { vendor_slug, lead } = req.body || {};
  if (!vendor_slug || !lead || !lead.id) {
    return res.status(400).json({ error: 'vendor_slug and lead are required' });
  }

  var row = {
    id: String(lead.id),
    vendor_slug: vendor_slug,
    name: lead.name || null,
    email: lead.email || null,
    phone: lead.phone || null,
    address: lead.address || null,
    interests: lead.interests || [],
    customer_notes: lead.customer_notes || null,
    notes: lead.notes || null,
    source: lead.source || null,
    created_at: lead.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/leads', {
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
    console.error('save-lead error:', await supaRes.text());
    return res.status(500).json({ error: 'Failed to save lead' });
  }

  var saved = await supaRes.json();
  return res.status(200).json(saved[0]);
};

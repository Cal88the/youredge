module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var { vendor_slug, pin } = req.body || {};
  if (!vendor_slug) {
    return res.status(400).json({ error: 'vendor_slug is required' });
  }

  // Verify PIN
  if (pin) {
    var pinRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendors?slug=eq.' + encodeURIComponent(vendor_slug) + '&select=pin&limit=1', {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
      }
    });
    var vendor = await pinRes.json();
    if (!vendor || !vendor.length) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    if (vendor[0].pin && String(vendor[0].pin) !== String(pin)) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }
  }

  // Fetch leads for this vendor
  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/leads?vendor_slug=eq.' + encodeURIComponent(vendor_slug) + '&order=created_at.desc', {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });

  if (!supaRes.ok) {
    console.error('get-leads error:', await supaRes.text());
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }

  var leads = await supaRes.json();
  return res.status(200).json(leads);
};

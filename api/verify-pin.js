module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var { slug, pin } = req.body || {};
  if (!slug || !pin) {
    return res.status(400).json({ error: 'slug and pin are required' });
  }

  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendors?slug=eq.' + encodeURIComponent(slug) + '&select=pin&limit=1', {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });

  if (!supaRes.ok) {
    return res.status(500).json({ error: 'Failed to verify' });
  }

  var rows = await supaRes.json();
  if (!rows || !rows.length) {
    return res.status(404).json({ error: 'Vendor not found' });
  }

  // If vendor has no PIN set yet, allow access
  if (!rows[0].pin) {
    return res.status(200).json({ ok: true });
  }

  if (String(rows[0].pin) !== String(pin)) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  return res.status(200).json({ ok: true });
};

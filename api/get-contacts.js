module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var password = req.headers['x-admin-password'] || req.query.password;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  var supaRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/vendor_contacts?select=*', {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });

  if (!supaRes.ok) {
    var err = await supaRes.text();
    return res.status(500).json({ error: 'Failed to load contacts', detail: err });
  }

  var rows = await supaRes.json();
  // Convert to slug-keyed object for easy client use
  var contactMap = {};
  rows.forEach(function(r) {
    contactMap[r.vendor_slug] = {
      name: r.contact_name || '',
      title: r.contact_title || '',
      email: r.contact_email || '',
      phone: r.contact_phone || '',
      notes: r.notes || '',
      cardPhoto: r.card_photo || ''
    };
  });

  return res.status(200).json(contactMap);
};

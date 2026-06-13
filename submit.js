// api/submit.js
// Vercel serverless function
// Receives survey submission → writes to Supabase → sends Resend confirmation email

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    property_slug,
    property_name,
    ev_status,
    would_use,
    unit_number,
    email,
    score
  } = req.body;

  // Basic validation
  if (!property_slug || !ev_status || !would_use || !unit_number || !email || score === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  // ── 1. Write to Supabase ──────────────────────────────────────────────────

  try {
    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        property_slug,
        ev_status,
        would_use,
        unit_number,
        email,
        score
      })
    });

    if (!dbRes.ok) {
      const err = await dbRes.text();
      console.error('Supabase error:', err);
      return res.status(500).json({ error: 'Database write failed' });
    }
  } catch (e) {
    console.error('Supabase fetch error:', e);
    return res.status(500).json({ error: 'Database connection failed' });
  }

  // ── 2. Send confirmation email via Resend ─────────────────────────────────

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'BasepointGrid <info@basepointgrid.com>',
        to: email,
        subject: `EV charging interest confirmed — ${property_name}`,
        text: `Hi,

We got your response for ${property_name}.

We're evaluating resident demand at your building right now. If enough residents are interested, we'll install chargers at no cost to the property owner.

We'll reach out when a decision has been made.

Questions? Text or call Devang at 925-452-7558.

— BasepointGrid
basepointgrid.com`
      })
    });
  } catch (e) {
    // Email failure is non-fatal — submission is already saved
    console.error('Resend error:', e);
  }

  return res.status(200).json({ success: true });
}

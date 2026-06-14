// api/dashboard.js
// Vercel serverless function
// Returns property demand summary + individual submissions for the dashboard.
//
// Protected by a shared secret token (DASHBOARD_TOKEN env var) passed as a
// query param. The dashboard HTML page embeds this token. The page itself
// lives at an unguessable URL, and this endpoint adds a second layer so the
// API can't be scraped independently even if discovered.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;

  if (!DASHBOARD_TOKEN || token !== DASHBOARD_TOKEN) {
    return res.status(404).json({ error: 'Not found' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  };

  try {
    // Summary per property
    const summaryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/property_demand_summary?select=*`,
      { headers: supabaseHeaders }
    );

    if (!summaryRes.ok) {
      const err = await summaryRes.text();
      console.error('Dashboard summary error:', err);
      return res.status(500).json({ error: 'Could not load summary' });
    }

    const summary = await summaryRes.json();

    // All individual submissions, most recent first
    const submissionsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/submissions?select=property_slug,ev_status,would_use,unit_number,email,score,created_at&order=created_at.desc`,
      { headers: supabaseHeaders }
    );

    if (!submissionsRes.ok) {
      const err = await submissionsRes.text();
      console.error('Dashboard submissions error:', err);
      return res.status(500).json({ error: 'Could not load submissions' });
    }

    const submissions = await submissionsRes.json();

    return res.status(200).json({ summary, submissions });

  } catch (e) {
    console.error('Dashboard fetch error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

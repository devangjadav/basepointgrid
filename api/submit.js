// api/submit.js
// Vercel serverless function
// Receives survey submission → validates → writes to Supabase → sends Resend confirmation email
//
// Protections:
// 1. Honeypot field — bots that autofill hidden fields get silently rejected
// 2. Property slug allowlist — only known property slugs accepted
// 3. Enum validation — ev_status / would_use must be from known sets
// 4. Email format validation
// 5. Duplicate check — one submission per email per property
// 6. Loose IP rate limit — backstop against flood attacks (20/hour), high enough
//    to never block a shared-apartment-WiFi IP under normal use

const VALID_PROPERTY_SLUGS = [
  'timbers',
  'parklane',
  'coral-gardens',
  'lakes-at-concord',
  'diablo-view',
  'whispering-oaks',
  'parkside-royale'
];

const VALID_EV_STATUS = ['yes', 'planning', 'would_consider', 'no'];
const VALID_WOULD_USE = ['definitely', 'probably', 'maybe', 'no'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const IP_RATE_LIMIT = 20;          // max submissions per IP per window
const IP_RATE_WINDOW_MINUTES = 60; // window size

export default async function handler(req, res) {
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
    score,
    website // honeypot field — real users never fill this
  } = req.body;

  // ── Honeypot check ─────────────────────────────────────────────────────────
  // If this is filled, it's a bot. Respond with success to avoid tipping it off,
  // but don't write anything or send any email.
  if (website) {
    return res.status(200).json({ success: true });
  }

  // ── Basic presence check ──────────────────────────────────────────────────
  if (!property_slug || !ev_status || !would_use || !unit_number || !email || score === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // ── Property slug allowlist ───────────────────────────────────────────────
  if (!VALID_PROPERTY_SLUGS.includes(property_slug)) {
    return res.status(400).json({ error: 'Invalid property' });
  }

  // ── Enum validation ────────────────────────────────────────────────────────
  if (!VALID_EV_STATUS.includes(ev_status) || !VALID_WOULD_USE.includes(would_use)) {
    return res.status(400).json({ error: 'Invalid response values' });
  }

  // ── Email format validation ───────────────────────────────────────────────
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // ── Unit number sanity check ──────────────────────────────────────────────
  if (typeof unit_number !== 'string' || unit_number.length === 0 || unit_number.length > 20) {
    return res.status(400).json({ error: 'Invalid unit number' });
  }

  // ── Score sanity check ─────────────────────────────────────────────────────
  if (typeof score !== 'number' || score < 0 || score > 10) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  };

  // Get client IP (Vercel populates this header)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  // ── IP rate limit check (loose backstop) ──────────────────────────────────
  try {
    const windowStart = new Date(Date.now() - IP_RATE_WINDOW_MINUTES * 60 * 1000).toISOString();

    const rateCheckRes = await fetch(
      `${SUPABASE_URL}/rest/v1/submission_log?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${windowStart}&select=id`,
      { headers: supabaseHeaders }
    );

    if (rateCheckRes.ok) {
      const rows = await rateCheckRes.json();
      if (rows.length >= IP_RATE_LIMIT) {
        return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
      }
    }
    // If the rate check itself fails, fail open — don't block legit users over
    // an infra hiccup. We still log this attempt below.
  } catch (e) {
    console.error('Rate limit check error:', e);
  }

  // ── Duplicate check — one submission per email per property ──────────────
  try {
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/submissions?property_slug=eq.${property_slug}&email=eq.${encodeURIComponent(email)}&select=id`,
      { headers: supabaseHeaders }
    );

    if (dupRes.ok) {
      const rows = await dupRes.json();
      if (rows.length > 0) {
        return res.status(409).json({ error: 'You\'ve already submitted a response for this property.' });
      }
    }
  } catch (e) {
    console.error('Duplicate check error:', e);
    // fail open — proceed with submission
  }

  // ── 1. Write to Supabase ──────────────────────────────────────────────────

  try {
    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
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

  // ── 2. Log this submission for rate limiting ──────────────────────────────
  // Non-fatal — if this fails, the submission is already saved.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/submission_log`, {
      method: 'POST',
      headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ip })
    });
  } catch (e) {
    console.error('Rate limit log error:', e);
  }

  // ── 3. Send confirmation email via Resend ─────────────────────────────────

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
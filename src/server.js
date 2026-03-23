require('dotenv').config();
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'parkingpro2024';

// ─── Company Configurations ──────────────────────────────────
const COMPANIES = {
  parkking: {
    name: 'Park King',
    baseUrl: process.env.PK_URL || 'https://parkdirect24.parkingpro.de',
    email: process.env.PK_EMAIL || '',
    password: process.env.PK_PASSWORD || ''
  },
  psfmsf: {
    name: 'PSF/MSF',
    baseUrl: process.env.PSF_URL || 'https://parkshuttlefly.parkingpro.de',
    email: process.env.PSF_EMAIL || '',
    password: process.env.PSF_PASSWORD || ''
  }
};

// ─── Vimcar Configuration ────────────────────────────────────
const VIMCAR = {
  baseUrl: 'https://fleet.vimcar.com',
  mapUrl: 'https://fleet.vimcar.com/dashboard/map/locations',
  email: process.env.VIMCAR_EMAIL || '',
  password: process.env.VIMCAR_PASSWORD || '',
};

// Vimcar session cookies (persist across scrapes)
let vimcarCookies = null;

// ─── Auth Middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ─── Scraping Logic ───────────────────────────────────────────
let browserInstance = null;

async function findChromePath() {
  const fs = require('fs');
  const { execSync } = require('child_process');

  // 1. Explicit env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Try to find chrome via puppeteer's own cache
  try {
    const result = execSync('find /opt/render -name "chrome" -type f 2>/dev/null || find /home -name "chrome" -type f 2>/dev/null || true', { encoding: 'utf8' });
    const paths = result.trim().split('\n').filter(p => p && !p.includes('crashpad'));
    if (paths.length > 0) {
      console.log('[Chrome] Found at:', paths[0]);
      return paths[0];
    }
  } catch (e) { /* ignore */ }

  // 3. Common system paths
  const systemPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 4. Let puppeteer figure it out
  return undefined;
}

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    const executablePath = await findChromePath();
    console.log('[Browser] Using Chrome at:', executablePath || 'puppeteer default');

    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    };
    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }
    browserInstance = await puppeteer.launch(launchOptions);
  }
  return browserInstance;
}

async function scrapeBookings(companyId) {
  const company = COMPANIES[companyId];
  if (!company) throw new Error('Unbekannte Firma: ' + companyId);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1400, height: 900 });

    // Step 1: Navigate to main URL
    console.log(`[Scraper][${company.name}] Step 1: Navigating...`);
    await page.goto(company.baseUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });
    await new Promise(r => setTimeout(r, 2000));

    // Step 2: ALWAYS go to login page and login first
    console.log(`[Scraper][${company.name}] Step 2: Login...`);
    await page.goto(company.baseUrl + '/authentication/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    const hasPasswordField = await page.evaluate(() => !!document.querySelector('input[type="password"]'));

    if (hasPasswordField) {
      const emailFilled = await page.evaluate((email) => {
        const selectors = ['input[type="email"]','input[name="email"]','input[name="username"]','#email','#username','input[type="text"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.type !== 'password') {
            el.value = email;
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
          }
        }
        return false;
      }, company.email);

      const passFilled = await page.evaluate((pass) => {
        const el = document.querySelector('input[type="password"]');
        if (el) {
          el.value = pass;
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return true;
        }
        return false;
      }, company.password);

      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => {
        const btns = ['button[type="submit"]','input[type="submit"]','.btn-primary','button.login','.btn-login'];
        for (const sel of btns) { const el = document.querySelector(sel); if (el) { el.click(); return; } }
        const form = document.querySelector('form');
        if (form) { const btn = form.querySelector('button, input[type="submit"]'); if (btn) btn.click(); }
      });

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      console.log(`[Scraper][${company.name}] Logged in, URL:`, page.url());
    }

    // Step 3: Navigate to day-all view
    console.log(`[Scraper][${company.name}] Step 3: Day view...`);
    await page.goto(company.baseUrl + '/#view=day-all', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    // Extra wait for SPA to render the hash route
    await new Promise(r => setTimeout(r, 5000));

    // Step 4: Wait for the Kendo grid with actual data
    console.log('[Scraper] Step 4: Waiting for grid data...');

    // Wait for tr[data-uid] elements (the actual data rows)
    let retries = 0;
    let rowCount = 0;
    while (retries < 10) {
      rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-uid]').length);
      console.log(`[Scraper] Retry ${retries}: Found ${rowCount} data rows`);
      if (rowCount > 0) break;
      await new Promise(r => setTimeout(r, 2000));
      retries++;
    }

    if (rowCount === 0) {
      // Debug: log what the page looks like
      const pageTitle = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log('[Scraper] DEBUG - Page title:', pageTitle);
      console.log('[Scraper] DEBUG - Body text:', bodyText);
      console.log('[Scraper] DEBUG - URL:', page.url());
    }

    // Step 5: Extract basic booking data from table
    console.log(`[Scraper][${company.name}] Step 5: Extracting bookings from table...`);
    const basicBookings = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-uid]');
      const results = [];

      for (const row of rows) {
        const getField = (field) => {
          const cell = row.querySelector(`td[data-field="${field}"]`);
          return cell ? (cell.textContent || '').trim() : '';
        };

        const name = getField('fullName()').replace(/^ParkKing:\s*/i, '').trim();
        const kennzeichen = getField('car.licensePlate');
        const zeit = getField('dayView.time');
        const parkdatum = getField('dayView.arrivalDate');
        const rueckgabe = getField('dayView.departureDate');
        const personen = getField('numberOfPersons');
        const tage = getField('parkedDaysCount()');
        const flug = getField('dayView.flightNumber');
        const telefon = getField('contactInformation.phone');
        const fahrzeug = getField('car.description');
        const code = getField('reservationCode');
        const uid = row.getAttribute('data-uid');

        const classList = row.className || '';
        let type = 'unknown';
        if (classList.includes('bg-success')) type = 'checkin';
        if (classList.includes('bg-danger')) type = 'checkout';

        if (kennzeichen || name) {
          results.push({
            name, kennzeichen, zeit, parkdatum, rueckgabe,
            personen, tage, flug, telefon, fahrzeug, code, type, uid
          });
        }
      }
      return results;
    });

    console.log(`[Scraper][${company.name}] Found ${basicBookings.length} bookings total`);

    // Step 6: For each CHECK-IN booking, click the row to open detail panel
    // and scrape the departure date+time from the detail view
    const checkinBookings = basicBookings.filter(b => b.type === 'checkin');
    console.log(`[Scraper][${company.name}] Step 6: Getting departure times for ${checkinBookings.length} check-ins...`);

    for (let i = 0; i < checkinBookings.length; i++) {
      const booking = checkinBookings[i];
      try {
        // Click the row to open detail panel
        const clicked = await page.evaluate((uid) => {
          const row = document.querySelector(`tr[data-uid="${uid}"]`);
          if (row) { row.click(); return true; }
          return false;
        }, booking.uid);

        if (!clicked) {
          console.log(`[Scraper] Could not click row for ${booking.kennzeichen}`);
          continue;
        }

        // Wait for detail panel to load with departure date
        await page.waitForFunction(() => {
          const el = document.querySelector('span[data-bind*="selectedEntity.departureDate"][data-format="g"]');
          return el && el.textContent.trim().length > 0;
        }, { timeout: 8000 }).catch(() => {});

        await new Promise(r => setTimeout(r, 500));

        // Extract the full departure datetime (e.g. "02.04.2026 22:50")
        const departureFull = await page.evaluate(() => {
          const el = document.querySelector('span[data-bind*="selectedEntity.departureDate"][data-format="g"]');
          return el ? el.textContent.trim() : '';
        });

        if (departureFull) {
          checkinBookings[i].rueckgabeVoll = departureFull;
          // Split into date and time
          const parts = departureFull.split(' ');
          if (parts.length >= 2) {
            checkinBookings[i].rueckgabeDatum = parts[0];
            checkinBookings[i].rueckgabeZeit = parts[1];
          }
        }

        console.log(`[Scraper] ${i+1}/${checkinBookings.length} ${booking.kennzeichen}: Rückgabe=${departureFull}`);
      } catch (err) {
        console.log(`[Scraper] Error getting detail for ${booking.kennzeichen}:`, err.message);
      }
    }

    // Extract the current displayed date
    const displayDate = await page.evaluate(() => {
      const dateEl = document.querySelector('[data-role="datefilter"] .k-input, .entity-list-filter input[type="date"]');
      if (dateEl && dateEl.value) return dateEl.value;
      return new Date().toLocaleDateString('de-DE');
    });

    // Return ALL bookings (with type info) so frontend can filter
    const allBookings = basicBookings.map(b => {
      const checkin = checkinBookings.find(c => c.uid === b.uid);
      if (checkin) return checkin;
      return b;
    });

    console.log(`[Scraper][${company.name}] Done! ${checkinBookings.length} check-ins with departure times`);
    return { bookings: allBookings, date: displayDate, scraped_at: new Date().toISOString() };

  } catch (error) {
    console.error('[Scraper] Error:', error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// ─── In-Memory Cache ─────────────────────────────────────────
// Stores scraped data per company, keyed by companyId + date
const cache = {};
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(companyId) {
  const today = new Date().toISOString().split('T')[0]; // e.g. "2026-03-23"
  return `${companyId}_${today}`;
}

function getCachedData(companyId) {
  const key = getCacheKey(companyId);
  const entry = cache[key];
  if (!entry) return null;
  // Check if cache is still fresh (max 24h)
  if (Date.now() - entry.timestamp > CACHE_MAX_AGE_MS) {
    delete cache[key];
    return null;
  }
  return entry.data;
}

function setCachedData(companyId, data) {
  const key = getCacheKey(companyId);
  cache[key] = { data, timestamp: Date.now() };
  // Clean up old entries (other dates)
  for (const k of Object.keys(cache)) {
    if (!k.endsWith('_' + new Date().toISOString().split('T')[0])) {
      delete cache[k];
    }
  }
}

// Track active scrapes to prevent duplicate requests
const activeScrapes = {};

// ─── API Routes ───────────────────────────────────────────────

// Login endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    res.json({ success: true, token: APP_PASSWORD });
  } else {
    res.status(401).json({ error: 'Falsches Passwort' });
  }
});

// Get available companies
app.get('/api/companies', requireAuth, (req, res) => {
  const list = Object.entries(COMPANIES).map(([id, c]) => ({ id, name: c.name }));
  res.json(list);
});

// Get bookings for a specific company
// ?refresh=true  → force re-scrape (ignore cache)
// Default        → return cached data if available
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const companyId = req.query.company || 'parkking';
    const forceRefresh = req.query.refresh === 'true';

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = getCachedData(companyId);
      if (cached) {
        console.log(`[Cache] HIT for ${companyId} (cached at ${new Date(cache[getCacheKey(companyId)].timestamp).toLocaleTimeString('de-DE')})`);
        return res.json({ ...cached, fromCache: true });
      }
    }

    // Prevent duplicate scrapes for the same company
    if (activeScrapes[companyId]) {
      console.log(`[Cache] Scrape already in progress for ${companyId}, waiting...`);
      try {
        const data = await activeScrapes[companyId];
        return res.json({ ...data, fromCache: true });
      } catch (error) {
        // Fall through to start new scrape
      }
    }

    console.log(`[Cache] ${forceRefresh ? 'REFRESH' : 'MISS'} for ${companyId} — starting scrape...`);

    // Start scrape and track the promise
    const scrapePromise = scrapeBookings(companyId);
    activeScrapes[companyId] = scrapePromise;

    const data = await scrapePromise;
    data.company = COMPANIES[companyId]?.name || companyId;

    // Store in cache
    setCachedData(companyId, data);
    delete activeScrapes[companyId];

    res.json({ ...data, fromCache: false });
  } catch (error) {
    delete activeScrapes[req.query.company || 'parkking'];
    console.error('Scrape error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Buchungen',
      detail: error.message
    });
  }
});

// ─── Vimcar Scraping Logic ───────────────────────────────────

// PLZ→Coordinates fallback mapping
const PLZ_COORDS = {
  '228': { lat: 53.696, lng: 9.989 },
  '200': { lat: 53.551, lng: 9.993 },
  '201': { lat: 53.551, lng: 9.993 },
  '224': { lat: 53.80, lng: 10.03 },
  '225': { lat: 53.66, lng: 9.90 },
  '226': { lat: 53.83, lng: 9.47 },
  '241': { lat: 54.32, lng: 10.13 },
  '100': { lat: 52.52, lng: 13.40 },
  '800': { lat: 48.14, lng: 11.58 },
  '600': { lat: 50.11, lng: 8.68 },
  '500': { lat: 50.94, lng: 6.96 },
  '300': { lat: 52.37, lng: 9.73 },
  '701': { lat: 48.78, lng: 9.18 },
  '900': { lat: 49.45, lng: 11.08 },
  '280': { lat: 53.08, lng: 8.80 },
};

function plzToCoords(address) {
  const m = (address || '').match(/(\d{5})/);
  if (!m) return { lat: 53.696, lng: 9.989 }; // Norderstedt default
  const p3 = m[1].substring(0, 3);
  return PLZ_COORDS[p3] || { lat: 53.55, lng: 9.99 };
}

async function scrapeVimcar() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // Restore cookies if we have them
    if (vimcarCookies) {
      await page.setCookie(...vimcarCookies);
      console.log(`[Vimcar] Restored ${vimcarCookies.length} cookies`);
    }

    // Navigate to map
    console.log('[Vimcar] Navigating to map...');
    await page.goto(VIMCAR.mapUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Check if we need to login
    const currentUrl = page.url();
    if (!currentUrl.includes('/dashboard')) {
      console.log('[Vimcar] Not logged in, attempting login...');

      await page.goto(VIMCAR.baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      // Try to fill email
      const emailSelectors = ['input[type="email"]', 'input[name="email"]', '#email', 'input[type="text"]'];
      for (const sel of emailSelectors) {
        const filled = await page.evaluate((s, email) => {
          const el = document.querySelector(s);
          if (el) { el.value = email; el.dispatchEvent(new Event('input', {bubbles:true})); return true; }
          return false;
        }, sel, VIMCAR.email);
        if (filled) break;
      }

      // Fill password
      await page.evaluate((pass) => {
        const el = document.querySelector('input[type="password"]');
        if (el) { el.value = pass; el.dispatchEvent(new Event('input', {bubbles:true})); }
      }, VIMCAR.password);

      await new Promise(r => setTimeout(r, 500));

      // Click submit
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]') || document.querySelector('form button');
        if (btn) btn.click();
      });

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      console.log('[Vimcar] Post-login URL:', page.url());

      if (!page.url().includes('/dashboard')) {
        throw new Error('Vimcar Login fehlgeschlagen. Bitte Zugangsdaten prüfen.');
      }

      // Navigate to map after login
      await page.goto(VIMCAR.mapUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
    }

    // Save cookies for next time
    vimcarCookies = await page.cookies();
    console.log(`[Vimcar] Saved ${vimcarCookies.length} cookies`);

    // Wait for vehicle list to appear
    console.log('[Vimcar] Waiting for vehicle data...');
    let retries = 0;
    let itemCount = 0;
    while (retries < 8) {
      itemCount = await page.evaluate(() => document.querySelectorAll('li.sc-erXPWQ').length);
      console.log(`[Vimcar] Retry ${retries}: ${itemCount} vehicle items`);
      if (itemCount > 0) break;
      await new Promise(r => setTimeout(r, 2000));
      retries++;
    }

    // Expand all vehicle items by clicking headers
    const headers = await page.$$('.sc-kApsTx');
    for (const header of headers) {
      try { await header.click(); await new Promise(r => setTimeout(r, 500)); } catch(e) { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 1000));

    // Extract vehicle data
    const vehicles = await page.evaluate(() => {
      const items = document.querySelectorAll('li.sc-erXPWQ');
      const results = [];

      items.forEach(item => {
        // Header row: plate + model from spans
        const headerSpans = [];
        const header = item.querySelector('.sc-kApsTx');
        if (header) {
          header.querySelectorAll('span').forEach(s => {
            const t = (s.textContent || '').trim();
            if (t && t.length > 1) headerSpans.push(t);
          });
        }

        // Try data-locator attributes first
        const plateEl = item.querySelector('[data-locator="license-plate"]');
        const modelEl = item.querySelector('[data-locator="model-name"]');
        const nicknameEl = item.querySelector('[data-locator="nickname"]');

        // Status elements in detail section
        const allP = item.querySelectorAll('p');
        let status = '', speed = '', location = '', tracking = '';
        allP.forEach(p => {
          const txt = (p.textContent || '').trim();
          if (txt === 'Unterwegs' || txt === 'Parkend' || txt === 'Offline') status = txt;
          else if (txt.includes('km/h')) speed = txt;
          else if (txt.includes('Ortung')) tracking = txt;
          else if (txt.includes(',') && txt.length > 15) location = txt; // address-like
        });

        results.push({
          plate: plateEl?.textContent?.trim() || headerSpans[0] || 'Unbekannt',
          model: modelEl?.textContent?.trim() || headerSpans[1] || '',
          nickname: nicknameEl?.textContent?.trim() || '',
          status,
          speed,
          location,
          tracking,
          timestamp: new Date().toISOString(),
        });
      });

      return results;
    });

    // Enrich with approximate coordinates from PLZ
    for (const v of vehicles) {
      const coords = plzToCoords(v.location);
      v.lat = coords.lat;
      v.lng = coords.lng;
      v.coordSource = 'plz-approx';
    }

    console.log(`[Vimcar] Done! ${vehicles.length} vehicles scraped`);
    return {
      vehicles,
      count: vehicles.length,
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    console.error('[Vimcar] Scrape error:', error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// Vimcar cache
let vimcarCache = null;
let vimcarCacheTime = 0;
const VIMCAR_CACHE_TTL = 30 * 1000; // 30 seconds

// ─── Vimcar API Routes ──────────────────────────────────────

app.get('/api/vimcar/vehicles', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();

    // Return cache if fresh enough
    if (!forceRefresh && vimcarCache && (now - vimcarCacheTime) < VIMCAR_CACHE_TTL) {
      return res.json({ ...vimcarCache, fromCache: true });
    }

    console.log('[Vimcar] Starting scrape...');
    const data = await scrapeVimcar();
    vimcarCache = data;
    vimcarCacheTime = now;
    res.json({ ...data, fromCache: false });
  } catch (error) {
    console.error('[Vimcar] API error:', error.message);
    res.status(500).json({ error: 'Vimcar Scraping fehlgeschlagen', detail: error.message });
  }
});

app.get('/api/vimcar/status', requireAuth, (req, res) => {
  res.json({
    configured: !!(VIMCAR.email && VIMCAR.password),
    hasSession: !!vimcarCookies,
    lastScrape: vimcarCacheTime ? new Date(vimcarCacheTime).toISOString() : null,
    vehicleCount: vimcarCache?.count || 0,
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
const AUTO_SCRAPE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function autoScrapeAll() {
  const companyIds = Object.keys(COMPANIES);
  for (const id of companyIds) {
    try {
      console.log(`[AutoScrape] Starting scrape for ${COMPANIES[id].name}...`);
      const data = await scrapeBookings(id);
      data.company = COMPANIES[id].name;
      setCachedData(id, data);
      const checkins = (data.bookings || []).filter(b => b.type === 'checkin');
      console.log(`[AutoScrape] ${COMPANIES[id].name}: ${checkins.length} check-ins cached ✓`);
    } catch (err) {
      console.error(`[AutoScrape] Error scraping ${COMPANIES[id].name}:`, err.message);
    }
  }
}

app.listen(PORT, () => {
  console.log(`🅿️  Label Print Tool Server running on port ${PORT}`);

  // Auto-scrape on startup (after 10 sec delay to let Chrome init)
  setTimeout(() => {
    console.log('[AutoScrape] Initial scrape starting...');
    autoScrapeAll();
  }, 10000);

  // Auto-scrape every 2 hours
  setInterval(() => {
    console.log('[AutoScrape] Scheduled refresh...');
    autoScrapeAll();
  }, AUTO_SCRAPE_INTERVAL_MS);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

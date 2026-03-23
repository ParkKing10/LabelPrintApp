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
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const companyId = req.query.company || 'parkking';
    const data = await scrapeBookings(companyId);
    data.company = COMPANIES[companyId]?.name || companyId;
    res.json(data);
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Buchungen',
      detail: error.message
    });
  }
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
app.listen(PORT, () => {
  console.log(`🅿️  ParkingPro Label Server running on port ${PORT}`);
  console.log(`   Dashboard URL: ${process.env.PARKINGPRO_URL || 'not set'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

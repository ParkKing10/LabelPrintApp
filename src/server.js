require('dotenv').config();
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'parkingpro2024';

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

async function scrapeBookings(dateStr) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set viewport
    await page.setViewport({ width: 1400, height: 900 });

    // Navigate to ParkingPro
    console.log('[Scraper] Navigating to ParkingPro...');
    await page.goto(process.env.PARKINGPRO_URL || 'https://parkdirect24.parkingpro.de/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Check if login is needed
    const needsLogin = await page.evaluate(() => {
      const loginForm = document.querySelector('input[type="email"], input[type="password"], input[name="email"], input[name="username"], #email, #login, .login-form, [name="login"]');
      return !!loginForm;
    });

    if (needsLogin) {
      console.log('[Scraper] Logging in...');

      // Try common email field selectors
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        '#email',
        '#username',
        'input[placeholder*="mail"]',
        'input[placeholder*="user"]',
        'input[placeholder*="Benutzer"]',
        'input[placeholder*="E-Mail"]'
      ];

      let emailField = null;
      for (const sel of emailSelectors) {
        emailField = await page.$(sel);
        if (emailField) break;
      }

      if (!emailField) {
        // Try first text/email input
        emailField = await page.$('input[type="text"], input[type="email"]');
      }

      if (emailField) {
        await emailField.click({ clickCount: 3 });
        await emailField.type(process.env.PARKINGPRO_EMAIL, { delay: 30 });
      }

      // Password field
      const passField = await page.$('input[type="password"]');
      if (passField) {
        await passField.click({ clickCount: 3 });
        await passField.type(process.env.PARKINGPRO_PASSWORD, { delay: 30 });
      }

      // Submit
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button.login',
        '.btn-login',
        'button:has-text("Login")',
        'button:has-text("Anmelden")'
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            submitted = true;
            break;
          }
        } catch (e) { /* try next */ }
      }

      if (!submitted) {
        await page.keyboard.press('Enter');
      }

      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    }

    // Navigate to day view
    const targetUrl = `https://parkdirect24.parkingpro.de/#view=day-all`;
    console.log('[Scraper] Navigating to day view...');

    if (page.url().includes('#view=day-all')) {
      // Already there, just reload
      await page.reload({ waitUntil: 'networkidle2' });
    } else {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    // Wait for table to appear
    await new Promise(r => setTimeout(r, 3000));

    // If a specific date is requested and it's not today, try to navigate to it
    if (dateStr) {
      const today = new Date().toISOString().split('T')[0];
      // The dashboard shows today by default; date navigation may need UI interaction
      // For now we scrape whatever date is shown
    }

    // Wait for the Kendo grid to fully render
    console.log('[Scraper] Waiting for Kendo grid...');
    await page.waitForSelector('tr[data-uid]', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Extract bookings using Kendo UI data-field attributes (exact selectors from HTML source)
    console.log('[Scraper] Extracting bookings via data-field attributes...');
    const bookings = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-uid]');
      const results = [];

      for (const row of rows) {
        // Helper: get text content of a cell by its data-field attribute
        const getField = (field) => {
          const cell = row.querySelector(`td[data-field="${field}"]`);
          return cell ? (cell.textContent || '').trim() : '';
        };

        // Extract all relevant fields using exact data-field selectors
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

        // Determine type from row CSS class
        const classList = row.className || '';
        let type = 'unknown';
        if (classList.includes('bg-success')) type = 'checkin';
        if (classList.includes('bg-danger')) type = 'checkout';

        // Only add rows that have meaningful data
        if (kennzeichen || name) {
          results.push({
            name,
            kennzeichen,
            zeit,
            parkdatum,
            rueckgabe,
            personen,
            tage,
            flug,
            telefon,
            fahrzeug,
            code,
            type
          });
        }
      }

      return results;
    });

    // Extract the current displayed date
    const displayDate = await page.evaluate(() => {
      // Try to find the date from the page header/filter
      const dateEl = document.querySelector('[data-role="datefilter"] .k-input, .entity-list-filter input[type="date"]');
      if (dateEl && dateEl.value) return dateEl.value;
      return new Date().toLocaleDateString('de-DE');
    });

    console.log(`[Scraper] Found ${bookings.length} bookings`);
    return { bookings, date: displayDate, scraped_at: new Date().toISOString() };

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

// Get bookings
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const data = await scrapeBookings(req.query.date);
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

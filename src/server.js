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

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
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
    // Use system Chromium in Docker/Render
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
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

    // Extract bookings from the table
    console.log('[Scraper] Extracting bookings...');
    const bookings = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      const results = [];

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 10) continue;

        // Skip rows that are group headers (Zeit: XX:XX)
        const rowText = row.textContent || '';
        if (rowText.includes('Zeit:') && rowText.includes('Anzahl:')) continue;

        // Extract data based on column positions from screenshot
        // Columns: [checkbox] [nr] [icons] [ausstehend] [zahlungsfrist] [zeit] [flug] [parkdatum] [rückgabe] [#pers] [#tage] [name] [telefon] [kennzeichen]
        const cellTexts = Array.from(cells).map(c => (c.textContent || '').trim());

        // Find the row number (first cell with a plain number)
        let nr = '';
        let zeit = '';
        let flug = '';
        let parkdatum = '';
        let rueckgabe = '';
        let personen = '';
        let tage = '';
        let name = '';
        let telefon = '';
        let kennzeichen = '';

        // The table structure based on screenshot:
        // We need to find cells by their content patterns
        for (let i = 0; i < cellTexts.length; i++) {
          const txt = cellTexts[i];

          // Row number (1-3 digit number, early in the row)
          if (i <= 2 && /^\d{1,3}$/.test(txt) && !nr) {
            nr = txt;
            continue;
          }

          // Time pattern (HH:MM)
          if (/^\d{2}:\d{2}$/.test(txt) && !zeit) {
            zeit = txt;
            continue;
          }

          // Date pattern (DD.MM.YYYY)
          if (/^\d{2}\.\d{2}\.\d{4}$/.test(txt)) {
            if (!parkdatum) { parkdatum = txt; continue; }
            if (!rueckgabe) { rueckgabe = txt; continue; }
          }

          // Personen (1-2 digit number after dates)
          if (/^\d{1,2}$/.test(txt) && parkdatum && !tage) {
            if (!personen) { personen = txt; continue; }
            tage = txt;
            continue;
          }

          // Phone number
          if (/^\+?\d{6,}/.test(txt.replace(/\s/g, ''))) {
            telefon = txt;
            continue;
          }

          // Kennzeichen pattern (XX-XX NNNN or similar, usually last meaningful column)
          if (/^[A-ZÄÖÜ]{1,4}[\s\-][A-ZÄÖÜ]{1,3}/.test(txt) && !kennzeichen) {
            kennzeichen = txt;
            continue;
          }
        }

        // Name: usually contains "ParkKing:" or is a regular name
        // Find it by looking for the cell that contains a name-like pattern
        for (let i = 0; i < cellTexts.length; i++) {
          const txt = cellTexts[i];
          if (txt.includes('ParkKing:') || txt.includes('Parking:')) {
            name = txt.replace(/^ParkKing:\s*/, '').replace(/^Parking:\s*/, '').trim();
            break;
          }
          // Regular name (First Last, after tage column)
          if (parkdatum && tage && !name && /^[A-ZÄÖÜ][a-zäöüß]+\s/.test(txt) && !telefon.includes(txt)) {
            name = txt;
          }
        }

        // Also try: name might just be a cell with letters and spaces
        if (!name) {
          for (let i = Math.max(0, cellTexts.length - 5); i < cellTexts.length; i++) {
            const txt = cellTexts[i];
            if (txt && /^[A-ZÄÖÜa-zäöüß\s\.\-]+$/.test(txt) && txt.length > 3 && !txt.includes('VOR') && !txt.includes('TO BE')) {
              name = txt;
              break;
            }
          }
        }

        if (kennzeichen || name) {
          results.push({
            nr,
            zeit,
            flug,
            parkdatum,
            rueckgabe,
            personen,
            tage,
            name,
            telefon,
            kennzeichen
          });
        }
      }

      return results;
    });

    // Also extract the current displayed date
    const displayDate = await page.evaluate(() => {
      const dateEl = document.querySelector('[class*="date"], .datum, h2, h3');
      const body = document.body.innerText;
      const match = body.match(/Datum:\s*(\d{2}\.\d{2}\.\d{4})/);
      return match ? match[1] : new Date().toLocaleDateString('de-DE');
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

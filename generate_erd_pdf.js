/**
 * generate_erd_pdf.js
 * Generates a PDF of the Reflex ERD diagram using Puppeteer.
 * Run: node generate_erd_pdf.js
 */
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  console.log('🚀 Launching headless browser...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const htmlPath = path.join(__dirname, 'frontend', 'reflex_erd_drawio.html');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

  console.log('📄 Loading ERD from:', fileUrl);
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for layout/rendering
  await new Promise(r => setTimeout(r, 1500));

  const outputPath = path.join(__dirname, 'frontend', 'Reflex_ERD.pdf');

  await page.pdf({
    path: outputPath,
    format: 'A4',
    landscape: true,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    preferCSSPageSize: true
  });

  await browser.close();

  console.log('✅ PDF saved to:', outputPath);
  console.log('🌐 Accessible at: http://localhost:3000/Reflex_ERD.pdf');
})();

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const https = require('https');

async function safeFetch(url, options = {}) {
  if (typeof fetch === 'function') {
    return fetch(url, options);
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function buildMailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ══════════════════════════════════════════════════════════════════════════
//  STORAGE LAYER — auto-detects MySQL vs JSON file
// ══════════════════════════════════════════════════════════════════════════
let db = null;       // MySQL pool (null when using JSON)
let useMySQL = false;

async function initStorage() {
  if (!process.env.DB_USER) {
    console.log('ℹ️  No DB_USER in .env — running in LOCAL mode (JSON file)');
    return;
  }
  try {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT) || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000,
    });
    // Test connection
    await pool.query('SELECT 1');
    db = pool;
    useMySQL = true;

    // Auto-migrate tables and missing columns for MySQL
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id VARCHAR(64) PRIMARY KEY,
          deliveryId VARCHAR(64),
          riderId VARCHAR(64),
          phone VARCHAR(32),
          amount DECIMAL(10,2),
          status VARCHAR(32),
          checkoutRequestId VARCHAR(128),
          mpesaRef VARCHAR(64),
          paidAt VARCHAR(64),
          createdAt VARCHAR(64)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      await pool.query("ALTER TABLE deliveries ADD COLUMN paymentStatus VARCHAR(32) DEFAULT 'UNPAID'").catch(() => { });
      await pool.query("ALTER TABLE deliveries ADD COLUMN mpesaRef VARCHAR(64) DEFAULT NULL").catch(() => { });
      await pool.query("ALTER TABLE deliveries ADD COLUMN deliveryOtp VARCHAR(6) DEFAULT NULL").catch(() => { });
      await pool.query("ALTER TABLE deliveries ADD COLUMN podToken VARCHAR(64) DEFAULT NULL").catch(() => { });
      await pool.query("ALTER TABLE deliveries ADD COLUMN verificationMethod VARCHAR(20) DEFAULT NULL").catch(() => { });
      await pool.query("ALTER TABLE deliveries ADD COLUMN verifiedAt DATETIME DEFAULT NULL").catch(() => { });
    } catch (e) { }

    console.log('✅ MySQL connected & schema verified — running in PRODUCTION mode');
  } catch (err) {
    db = null;
    useMySQL = false;
    console.log(`⚠️  MySQL unavailable (${err.message}) — falling back to JSON file (LOCAL mode)`);
  }
}

function generatePodCredentials(deliveryId) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const hex = require('crypto').randomBytes(3).toString('hex');
  const podToken = `POD-${deliveryId || 'REF'}-${hex}`;
  return { otp, podToken };
}

// ── JSON helpers ──────────────────────────────────────────────────────────
const jRead = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const jWrite = d => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
const now = () => new Date().toISOString();

// ── Mpesa Daraja helpers ───────────────────────────────────────────────────
async function mpesaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const env = process.env.MPESA_ENV === 'production' ? 'api' : 'sandbox';
  const url = `https://${env}.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`;
  const b64 = Buffer.from(`${key}:${secret}`).toString('base64');
  const r = await safeFetch(url, { headers: { Authorization: `Basic ${b64}` } });
  const data = await readDarajaResponse(r, 'Mpesa auth');
  if (!data.access_token) throw new Error('Mpesa auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function readDarajaResponse(response, operation) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation} failed (HTTP ${response.status}): ${text || 'empty response'}`);
  }
  if (!response.ok) {
    throw new Error(`${operation} failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function stkPush(phone, amount, accountRef, desc) {
  const token = await mpesaToken();
  const env = process.env.MPESA_ENV === 'production' ? 'api' : 'sandbox';
  const shortCode = process.env.MPESA_SHORT_CODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
  // Normalise phone: 0712345678 → 254712345678
  let ph = (phone + '').replace(/[^0-9]/g, '');
  if (ph.startsWith('0')) ph = '254' + ph.slice(1);
  const body = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: ph,
    PartyB: shortCode,
    PhoneNumber: ph,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: accountRef,
    TransactionDesc: desc
  };
  const r = await safeFetch(`https://${env}.safaricom.co.ke/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return readDarajaResponse(r, 'STK Push');
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (useMySQL) {
      const [rows] = await db.query('SELECT * FROM users WHERE email=? AND password=?', [email, password]);
      if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });
      const { password: _pw, ...safe } = rows[0];
      return res.json(safe);
    }
    // JSON fallback
    const d = jRead();
    const u = d.users.find(x => x.email === email && x.password === password);
    if (!u) return res.status(401).json({ error: 'Invalid email or password' });
    const { password: _pw, ...safe } = u;
    res.json(safe);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — GET LIST
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/deliveries', async (req, res) => {
  try {
    const { role, userId } = req.query;
    if (useMySQL) {
      let sql = `SELECT d.*,ru.name AS retailerName,ri.name AS riderName
                 FROM deliveries d
                 LEFT JOIN users ru ON ru.id=d.retailerId
                 LEFT JOIN users ri ON ri.id=d.riderId`;
      const params = [];
      if (role === 'rider') { sql += ' WHERE (d.status=? OR d.riderId=?)'; params.push('Open', userId); }
      if (role === 'retailer') { sql += ' WHERE d.retailerId=?'; params.push(userId); }
      sql += ' ORDER BY d.createdAt DESC';
      const [deliveries] = await db.query(sql, params);
      for (const d of deliveries) {
        const [hist] = await db.query(
          'SELECT status, at_time AS `at`, note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [d.id]);
        d.history = hist;
      }
      return res.json(deliveries);
    }
    // JSON fallback
    const d = jRead();
    const decorate = x => ({
      ...x,
      retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown',
      riderName: d.users.find(u => u.id === x.riderId)?.name || null,
    });
    let list = d.deliveries.map(decorate);
    if (role === 'rider') list = list.filter(x => x.status === 'Open' || x.riderId === userId);
    if (role === 'retailer') list = list.filter(x => x.retailerId === userId);
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json(list);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — GET SINGLE
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/deliveries/:id', async (req, res) => {
  try {
    if (useMySQL) {
      const [[row]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`,
        [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Delivery not found' });
      const [hist] = await db.query(
        'SELECT status, at_time AS `at`, note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [row.id]);
      row.history = hist;
      return res.json(row);
    }
    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(x => x.id === req.params.id);
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    res.json({
      ...x, retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown',
      riderName: d.users.find(u => u.id === x.riderId)?.name || null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — CREATE
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/deliveries', async (req, res) => {
  try {
    const { retailerId, customerName, customerPhone, address, item } = req.body;
    if (!retailerId || !customerName || !customerPhone || !address || !item)
      return res.status(400).json({ error: 'All fields are required' });

    if (useMySQL) {
      const [[{ maxId }]] = await db.query(
        "SELECT MAX(CAST(SUBSTRING(id,5) AS UNSIGNED)) AS maxId FROM deliveries");
      const newId = `DEL-${(maxId || 1000) + 1}`;
      const t = now();
      const { otp, podToken } = generatePodCredentials(newId);
      await db.query(
        `INSERT INTO deliveries(id,retailerId,customerName,customerPhone,address,item,riderId,status,paymentStatus,deliveryOtp,podToken,createdAt,updatedAt)
         VALUES(?,?,?,?,?,?,NULL,'Open','UNPAID',?,?,?,?)`, [newId, retailerId, customerName, customerPhone, address, item, otp, podToken, t, t]);
      await db.query(
        'INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
        [newId, 'Open', t, 'Delivery created by business owner']);
      const [[delivery]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [newId]);
      const [hist] = await db.query(
        'SELECT status,at_time AS `at`,note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [newId]);
      delivery.history = hist;
      return res.status(201).json(delivery);
    }
    // JSON fallback
    const d = jRead();
    const t = now();
    const newId = `DEL-${Math.max(1000, ...d.deliveries.map(x => Number(x.id.replace('DEL-', '')))) + 1}`;
    const { otp, podToken } = generatePodCredentials(newId);
    const x = {
      id: newId, retailerId, customerName, customerPhone, address, item,
      riderId: null, status: 'Open', paymentStatus: 'UNPAID', mpesaRef: null,
      deliveryOtp: otp, podToken, verificationMethod: null, verifiedAt: null,
      createdAt: t, updatedAt: t,
      history: [{ status: 'Open', at: t, note: 'Delivery created by business owner' }]
    };
    d.deliveries.push(x);
    jWrite(d);
    res.status(201).json({
      ...x,
      retailerName: d.users.find(u => u.id === retailerId)?.name || 'Unknown', riderName: null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — DELETE / CANCEL
// ══════════════════════════════════════════════════════════════════════════
app.delete('/api/deliveries/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [id]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      await db.query('DELETE FROM delivery_history WHERE deliveryId=?', [id]);
      await db.query('DELETE FROM deliveries WHERE id=?', [id]);
      return res.json({ ok: true, message: `Delivery ${id} deleted successfully` });
    }
    // JSON fallback
    const d = jRead();
    const idx = d.deliveries.findIndex(x => x.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Delivery not found' });
    d.deliveries.splice(idx, 1);
    jWrite(d);
    res.json({ ok: true, message: `Delivery ${id} deleted successfully` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — ACCEPT (rider)
// ══════════════════════════════════════════════════════════════════════════
app.patch('/api/deliveries/:id/accept', async (req, res) => {
  try {
    if (useMySQL) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const [[delivery]] = await conn.query('SELECT * FROM deliveries WHERE id=? FOR UPDATE', [req.params.id]);
        if (!delivery) { await conn.rollback(); return res.status(404).json({ error: 'Delivery not found' }); }
        const [[rider]] = await conn.query("SELECT * FROM users WHERE id=? AND role='rider'", [req.body.riderId]);
        if (!rider) { await conn.rollback(); return res.status(400).json({ error: 'Valid rider is required' }); }
        if (delivery.status !== 'Open') { await conn.rollback(); return res.status(409).json({ error: 'Already claimed or assigned' }); }
        const t = now();
        await conn.query("UPDATE deliveries SET riderId=?,status='Claimed',updatedAt=? WHERE id=?", [rider.id, t, delivery.id]);
        await conn.query('INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
          [delivery.id, 'Claimed', t, `Claimed by ${rider.name} (Pending Dispatcher Approval)`]);
        await conn.commit();
        const [[updated]] = await db.query(
          `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
           LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [delivery.id]);
        const [hist] = await db.query(
          'SELECT status,at_time AS `at`,note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [delivery.id]);
        updated.history = hist;
        return res.json(updated);
      } finally { conn.release(); }
    }
    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(x => x.id === req.params.id);
    const r = d.users.find(u => u.id === req.body.riderId && u.role === 'rider');
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    if (!r) return res.status(400).json({ error: 'Valid rider is required' });
    if (x.status !== 'Open') return res.status(409).json({ error: 'Already claimed or assigned' });
    const t = now(); x.riderId = r.id; x.status = 'Claimed'; x.updatedAt = t;
    x.history = x.history || []; x.history.push({ status: 'Claimed', at: t, note: `Claimed by ${r.name} (Pending Dispatcher Approval)` });
    jWrite(d);
    res.json({ ...x, retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown', riderName: r.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — ASSIGN (dispatcher)
// ══════════════════════════════════════════════════════════════════════════
app.patch('/api/deliveries/:id/assign', async (req, res) => {
  try {
    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [req.params.id]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      if (delivery.paymentStatus !== 'PAID')
        return res.status(400).json({ error: 'Payment pending: Business owner must pay Ksh 2 fee via M-Pesa before rider assignment.' });
      const [[rider]] = await db.query("SELECT * FROM users WHERE id=? AND role='rider'", [req.body.riderId]);
      if (!rider) return res.status(400).json({ error: 'Valid rider is required' });
      if (['Delivered', 'Cancelled'].includes(delivery.status))
        return res.status(409).json({ error: 'Cannot reassign this delivery' });
      const t = now();
      await db.query("UPDATE deliveries SET riderId=?,status='Assigned',updatedAt=? WHERE id=?", [rider.id, t, delivery.id]);
      await db.query("UPDATE payments SET riderId=? WHERE deliveryId=?", [rider.id, delivery.id]).catch(() => {});
      await db.query('INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
        [delivery.id, 'Assigned', t, `Assigned to ${rider.name}`]);
      const [[updated]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [delivery.id]);
      const [hist] = await db.query(
        'SELECT status,at_time AS `at`,note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [delivery.id]);
      updated.history = hist;
      return res.json(updated);
    }
    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(x => x.id === req.params.id);
    const r = d.users.find(u => u.id === req.body.riderId && u.role === 'rider');
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    if (x.paymentStatus !== 'PAID')
      return res.status(400).json({ error: 'Payment pending: Business owner must pay Ksh 2 fee via M-Pesa before rider assignment.' });
    if (!r) return res.status(400).json({ error: 'Valid rider is required' });
    if (['Delivered', 'Cancelled'].includes(x.status)) return res.status(409).json({ error: 'Cannot reassign' });
    const t = now(); x.riderId = r.id; x.status = 'Assigned'; x.updatedAt = t;
    (d.payments || []).forEach(p => { if (p.deliveryId === x.id) p.riderId = r.id; });
    x.history = x.history || []; x.history.push({ status: 'Assigned', at: t, note: `Assigned to ${r.name}` });
    jWrite(d);
    res.json({ ...x, retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown', riderName: r.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — UPDATE STATUS (rider / owner)
// ══════════════════════════════════════════════════════════════════════════
app.patch('/api/deliveries/:id/status', async (req, res) => {
  try {
    const order = { Open: 0, Claimed: 1, Assigned: 2, 'Picked Up': 3, 'Out for Delivery': 4, 'Pending Confirmation': 5, Delivered: 6, Failed: 6, Cancelled: 6 };
    const { status: next, riderId } = req.body;
    if (!Object.prototype.hasOwnProperty.call(order, next))
      return res.status(400).json({ error: 'Invalid status' });

    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [req.params.id]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      if (riderId && delivery.riderId !== riderId && next !== 'Delivered') return res.status(403).json({ error: 'Not your delivery' });
      if (order[next] < order[delivery.status]) return res.status(409).json({ error: 'Status cannot move backwards' });
      if (next === 'Pending Confirmation' && delivery.status !== 'Out for Delivery') return res.status(409).json({ error: 'Start delivery first' });
      if (next === 'Delivered' && !['Out for Delivery', 'Pending Confirmation'].includes(delivery.status)) return res.status(409).json({ error: 'Cannot confirm delivery yet' });
      if (next === 'Picked Up' && delivery.status !== 'Assigned') return res.status(409).json({ error: 'Accept delivery first' });
      if (next === 'Out for Delivery' && delivery.status !== 'Picked Up') return res.status(409).json({ error: 'Pick up first' });
      const t = now();
      const note = next === 'Pending Confirmation' ? 'Rider marked as delivered (Awaiting Business Owner confirmation)'
        : next === 'Delivered' ? 'Delivery confirmed received by Business Owner'
          : 'Status updated by rider';
      await db.query('UPDATE deliveries SET status=?,updatedAt=? WHERE id=?', [next, t, delivery.id]);
      await db.query('INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
        [delivery.id, next, t, note]);
      const [[updated]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [delivery.id]);
      const [hist] = await db.query(
        'SELECT status,at_time AS `at`,note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [delivery.id]);
      updated.history = hist;
      return res.json(updated);
    }
    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(x => x.id === req.params.id);
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    if (riderId && x.riderId !== riderId && next !== 'Delivered') return res.status(403).json({ error: 'Not your delivery' });
    if (order[next] < order[x.status]) return res.status(409).json({ error: 'Status cannot move backwards' });
    if (next === 'Pending Confirmation' && x.status !== 'Out for Delivery') return res.status(409).json({ error: 'Start delivery first' });
    if (next === 'Delivered' && !['Out for Delivery', 'Pending Confirmation'].includes(x.status)) return res.status(409).json({ error: 'Cannot confirm delivery yet' });
    if (next === 'Picked Up' && x.status !== 'Assigned') return res.status(409).json({ error: 'Accept delivery first' });
    if (next === 'Out for Delivery' && x.status !== 'Picked Up') return res.status(409).json({ error: 'Pick up first' });
    const t = now(); x.status = next; x.updatedAt = t;
    const note = next === 'Pending Confirmation' ? 'Rider marked as delivered (Awaiting Business Owner confirmation)'
      : next === 'Delivered' ? 'Delivery confirmed received by Business Owner'
        : 'Status updated by rider';
    x.history = x.history || []; x.history.push({ status: next, at: t, note });
    jWrite(d);
    res.json({
      ...x, retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown',
      riderName: d.users.find(u => u.id === x.riderId)?.name || null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — VERIFY PROOF OF DELIVERY (PoD: OTP / QR Code)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/deliveries/:id/verify-pod', async (req, res) => {
  try {
    const deliveryId = req.params.id;
    const { riderId, otp, token } = req.body;

    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      if (riderId && delivery.riderId !== riderId) return res.status(403).json({ error: 'Unauthorized: Not your assigned delivery' });
      if (delivery.status !== 'Out for Delivery') {
        return res.status(400).json({ error: `Cannot verify delivery in '${delivery.status}' status. Must be 'Out for Delivery'.` });
      }

      let method = null;
      if (otp && String(otp).trim() === String(delivery.deliveryOtp)) {
        method = 'OTP';
      } else if (token && String(token).trim() === String(delivery.podToken)) {
        method = 'QR_CODE';
      } else {
        return res.status(400).json({ error: 'Invalid verification code or QR token. Please verify and try again.' });
      }

      const t = now();
      const note = `Delivered & verified via ${method === 'QR_CODE' ? 'QR Code scan' : 'Customer OTP'}`;
      await db.query(
        "UPDATE deliveries SET status='Delivered', verificationMethod=?, verifiedAt=?, updatedAt=? WHERE id=?",
        [method, t, t, deliveryId]
      );
      await db.query(
        'INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
        [deliveryId, 'Delivered', t, note]
      );

      const [[updated]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [deliveryId]);
      const [hist] = await db.query(
        'SELECT status,at_time AS `at`,note FROM delivery_history WHERE deliveryId=? ORDER BY at_time', [deliveryId]);
      updated.history = hist;
      return res.json({ success: true, message: `Delivery confirmed via ${method === 'QR_CODE' ? 'QR Code' : 'OTP'}!`, method, delivery: updated });
    }

    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(item => item.id === deliveryId);
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    if (riderId && x.riderId !== riderId) return res.status(403).json({ error: 'Unauthorized: Not your assigned delivery' });
    if (x.status !== 'Out for Delivery') {
      return res.status(400).json({ error: `Cannot verify delivery in '${x.status}' status. Must be 'Out for Delivery'.` });
    }

    let method = null;
    if (otp && String(otp).trim() === String(x.deliveryOtp)) {
      method = 'OTP';
    } else if (token && String(token).trim() === String(x.podToken)) {
      method = 'QR_CODE';
    } else {
      return res.status(400).json({ error: 'Invalid verification code or QR token. Please verify and try again.' });
    }

    const t = now();
    const note = `Delivered & verified via ${method === 'QR_CODE' ? 'QR Code scan' : 'Customer OTP'}`;
    x.status = 'Delivered';
    x.verificationMethod = method;
    x.verifiedAt = t;
    x.updatedAt = t;
    x.history = x.history || [];
    x.history.push({ status: 'Delivered', at: t, note });
    jWrite(d);

    res.json({
      success: true,
      message: `Delivery confirmed via ${method === 'QR_CODE' ? 'QR Code' : 'OTP'}!`,
      method,
      delivery: {
        ...x,
        retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown',
        riderName: d.users.find(u => u.id === x.riderId)?.name || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during PoD verification' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC CUSTOMER PROOF OF DELIVERY (Customer Scans Rider QR Code)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/public/deliveries/:id', async (req, res) => {
  try {
    const deliveryId = req.params.id;
    if (useMySQL) {
      const [[row]] = await db.query(
        `SELECT d.id, d.customerName, d.customerPhone, d.address, d.item, d.status, d.podToken, d.deliveryOtp, d.verificationMethod, d.verifiedAt, d.createdAt,
                ru.name AS retailerName, ri.name AS riderName, ri.phone AS riderPhone
         FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId
         LEFT JOIN users ri ON ri.id=d.riderId
         WHERE d.id=?`, [deliveryId]);
      if (!row) return res.status(404).json({ error: 'Delivery not found' });
      return res.json(row);
    }
    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(item => item.id === deliveryId);
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    const rider = d.users.find(u => u.id === x.riderId);
    const retailer = d.users.find(u => u.id === x.retailerId);
    res.json({
      id: x.id,
      customerName: x.customerName,
      customerPhone: x.customerPhone,
      address: x.address,
      item: x.item,
      status: x.status,
      podToken: x.podToken,
      deliveryOtp: x.deliveryOtp,
      verificationMethod: x.verificationMethod,
      verifiedAt: x.verifiedAt,
      createdAt: x.createdAt,
      retailerName: retailer?.name || 'Retailer',
      riderName: rider?.name || 'Rider',
      riderPhone: rider?.phone || null
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/public/deliveries/:id/confirm', async (req, res) => {
  try {
    const deliveryId = req.params.id;
    const { token, otp, rating, note: customerNote } = req.body;

    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      if (delivery.status === 'Delivered') {
        return res.json({ success: true, alreadyDelivered: true, message: 'This delivery has already been confirmed.' });
      }
      if (delivery.status !== 'Out for Delivery') {
        return res.status(400).json({ error: `Cannot confirm delivery in '${delivery.status}' status. Delivery must be Out for Delivery.` });
      }

      const isValidToken = token && String(token).trim() === String(delivery.podToken);
      const isValidOtp = otp && String(otp).trim() === String(delivery.deliveryOtp);

      if (!isValidToken && !isValidOtp) {
        return res.status(400).json({ error: 'Invalid verification token or PIN. Please scan the rider QR again.' });
      }

      const t = now();
      const histNote = `Delivery confirmed received by customer (${delivery.customerName}) via QR Scan${rating ? ` ★${rating}/5` : ''}${customerNote ? ` - "${customerNote}"` : ''}`;

      await db.query(
        "UPDATE deliveries SET status='Delivered', verificationMethod='CUSTOMER_QR_SCAN', verifiedAt=?, updatedAt=? WHERE id=?",
        [t, t, deliveryId]
      );
      await db.query(
        'INSERT INTO delivery_history(deliveryId,status,at_time,note) VALUES(?,?,?,?)',
        [deliveryId, 'Delivered', t, histNote]
      );

      const [[updated]] = await db.query(
        `SELECT d.*,ru.name AS retailerName,ri.name AS riderName FROM deliveries d
         LEFT JOIN users ru ON ru.id=d.retailerId LEFT JOIN users ri ON ri.id=d.riderId WHERE d.id=?`, [deliveryId]);

      return res.json({ success: true, message: 'Thank you! Your delivery has been confirmed.', delivery: updated });
    }

    // JSON fallback
    const d = jRead();
    const x = d.deliveries.find(item => item.id === deliveryId);
    if (!x) return res.status(404).json({ error: 'Delivery not found' });
    if (x.status === 'Delivered') {
      return res.json({ success: true, alreadyDelivered: true, message: 'This delivery has already been confirmed.' });
    }
    if (x.status !== 'Out for Delivery') {
      return res.status(400).json({ error: `Cannot confirm delivery in '${x.status}' status. Delivery must be Out for Delivery.` });
    }

    const isValidToken = token && String(token).trim() === String(x.podToken);
    const isValidOtp = otp && String(otp).trim() === String(x.deliveryOtp);

    if (!isValidToken && !isValidOtp) {
      return res.status(400).json({ error: 'Invalid verification token or PIN. Please scan the rider QR again.' });
    }

    const t = now();
    const histNote = `Delivery confirmed received by customer (${x.customerName}) via QR Scan${rating ? ` ★${rating}/5` : ''}${customerNote ? ` - "${customerNote}"` : ''}`;

    x.status = 'Delivered';
    x.verificationMethod = 'CUSTOMER_QR_SCAN';
    x.verifiedAt = t;
    x.updatedAt = t;
    x.history = x.history || [];
    x.history.push({ status: 'Delivered', at: t, note: histNote });
    jWrite(d);

    res.json({
      success: true,
      message: 'Thank you! Your delivery has been confirmed.',
      delivery: {
        ...x,
        retailerName: d.users.find(u => u.id === x.retailerId)?.name || 'Unknown',
        riderName: d.users.find(u => u.id === x.riderId)?.name || null
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  DELIVERIES — NOTIFY OWNER via Email (dispatcher)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/deliveries/:id/notify-owner', async (req, res) => {
  try {
    const { message, toEmail, subject } = req.body;
    const deliveryId = req.params.id;
    const emailBody = message || `Reflex Deliveries Notice: Update regarding order ${deliveryId}`;
    const emailSubj = subject || `Reflex Deliveries — Order ${deliveryId} Notification`;

    if (!toEmail) return res.status(400).json({ error: 'Recipient email address is required' });

    const mailer = buildMailer();
    if (!mailer) {
      return res.status(503).json({
        error: 'Email not configured. Add SMTP_USER and SMTP_PASS to your .env file.'
      });
    }

    await mailer.sendMail({
      from: `"Reflex Deliveries" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: emailSubj,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          <div style="background:#a51d2d;padding:20px 28px">
            <h2 style="color:#fff;margin:0;font-size:18px">Reflex Deliveries</h2>
            <p style="color:#fcd5d9;margin:4px 0 0;font-size:13px">Delivery Management System</p>
          </div>
          <div style="padding:28px">
            <p style="font-size:14px;color:#344054;margin-top:0">Hello,</p>
            <p style="font-size:14px;color:#344054">${emailBody.replace(/\n/g, '<br>')}</p>
            <div style="background:#f9fafb;border-radius:6px;padding:14px 18px;margin:20px 0;border-left:4px solid #a51d2d">
              <p style="margin:0;font-size:13px;color:#667085">Order Reference</p>
              <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:#1d2939">${deliveryId}</p>
            </div>
            <p style="font-size:12px;color:#98a2b3;margin-bottom:0">This is an automated notification from Reflex Deliveries.</p>
          </div>
        </div>
      `,
      text: emailBody
    });

    res.json({ ok: true, message: `Email notification sent to ${toEmail}` });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Failed to send email' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  RIDERS — CREATE NEW RIDER ACCOUNT (dispatcher only)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/riders', async (req, res) => {
  try {
    const { role, name, email, password, phone } = req.body;
    if (role !== 'dispatcher') {
      return res.status(403).json({ error: 'Access denied: Dispatchers only' });
    }
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const newId = 'USR-' + Date.now();

    if (useMySQL) {
      const [[exists]] = await db.query('SELECT id FROM users WHERE LOWER(email)=?', [cleanEmail]);
      if (exists) return res.status(409).json({ error: 'An account with this email already exists' });
      await db.query(
        'INSERT INTO users(id, name, email, password, role, phone) VALUES(?,?,?,?,?,?)',
        [newId, name.trim(), cleanEmail, password, 'rider', phone ? phone.trim() : null]
      );
      return res.status(201).json({ id: newId, name: name.trim(), email: cleanEmail, role: 'rider', phone: phone ? phone.trim() : null });
    }

    // JSON fallback
    const d = jRead();
    if (d.users.some(u => u.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const newUser = {
      id: newId,
      name: name.trim(),
      email: cleanEmail,
      password: password,
      role: 'rider',
      phone: phone ? phone.trim() : null
    };
    d.users.push(newUser);
    jWrite(d);

    const { password: _, ...safeUser } = newUser;
    res.status(201).json(safeUser);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  MPESA — RIDER EARNINGS GET
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/earnings/:riderId', async (req, res) => {
  try {
    const riderId = req.params.riderId;
    if (useMySQL) {
      const [payments] = await db.query(
        `SELECT p.id, p.deliveryId, COALESCE(p.riderId, d.riderId) AS riderId, p.amount, p.status, p.mpesaRef, p.paidAt, p.createdAt
         FROM payments p
         LEFT JOIN deliveries d ON d.id = p.deliveryId
         WHERE (p.riderId = ? OR d.riderId = ?) AND p.status = 'PAID'
         ORDER BY COALESCE(p.paidAt, p.createdAt) DESC`,
        [riderId, riderId]
      );
      const total = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      return res.json({ payments, total });
    }

    const d = jRead();
    const riderDeliveries = (d.deliveries || []).filter(del => del.riderId === riderId);
    const riderDeliveryMap = new Map(riderDeliveries.map(del => [del.id, del]));

    const matchedPaymentDeliveryIds = new Set();
    const paymentsList = [];

    (d.payments || []).forEach(p => {
      if (p.status === 'PAID' && (p.riderId === riderId || riderDeliveryMap.has(p.deliveryId))) {
        matchedPaymentDeliveryIds.add(p.deliveryId);
        paymentsList.push({
          ...p,
          riderId: riderId,
          amount: Number(p.amount) || 2
        });
      }
    });

    // Also include any assigned deliveries marked as PAID that don't have a standalone payments row
    riderDeliveries.forEach(del => {
      if (del.paymentStatus === 'PAID' && !matchedPaymentDeliveryIds.has(del.id)) {
        paymentsList.push({
          id: 'PAY-' + del.id,
          deliveryId: del.id,
          riderId: riderId,
          amount: 2,
          status: 'PAID',
          mpesaRef: del.mpesaRef || 'PAID',
          paidAt: del.verifiedAt || del.updatedAt || del.createdAt,
          createdAt: del.createdAt
        });
      }
    });

    const total = paymentsList.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    res.json({ payments: paymentsList, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  MPESA — STK PUSH (triggered on delivery create / payment modal)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/mpesa/stk-push', async (req, res) => {
  try {
    const { phone, deliveryId, riderId } = req.body;
    if (!phone || !deliveryId) return res.status(400).json({ error: 'Phone and deliveryId required' });
    const amount = Number(process.env.MPESA_AMOUNT) || 2;
    const result = await stkPush(phone, amount, deliveryId, `Delivery ${deliveryId} fee`);
    if (result.ResponseCode === '0') {
      const payId = 'PAY-' + Date.now();
      const t = now();
      if (useMySQL) {
        await db.query(
          `INSERT INTO payments(id, deliveryId, riderId, phone, amount, status, checkoutRequestId, createdAt)
           VALUES(?,?,?,?,?,'PENDING',?,?)`,
          [payId, deliveryId, riderId || null, phone, amount, result.CheckoutRequestID, t]
        );
      } else {
        const d = jRead();
        if (!d.payments) d.payments = [];
        d.payments.push({
          id: payId,
          deliveryId,
          riderId: riderId || null,
          phone,
          amount,
          status: 'PENDING',
          checkoutRequestId: result.CheckoutRequestID,
          createdAt: t
        });
        jWrite(d);
      }
      res.json({ ok: true, message: 'STK Push sent. Enter Mpesa PIN on your phone.', data: result });
    } else {
      res.status(400).json({ error: result.errorMessage || result.CustomerMessage || 'STK Push failed', data: result });
    }
  } catch(err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  MPESA — CHECK PAYMENT STATUS (polling endpoint)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/mpesa/status/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (useMySQL) {
      const [[delivery]] = await db.query('SELECT * FROM deliveries WHERE id=?', [id]);
      if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
      const [[payment]] = await db.query('SELECT * FROM payments WHERE deliveryId=? ORDER BY createdAt DESC LIMIT 1', [id]);
      const [[retailer]] = await db.query('SELECT name FROM users WHERE id=?', [delivery.retailerId]);
      return res.json({
        paid: delivery.paymentStatus === 'PAID',
        paymentStatus: delivery.paymentStatus || 'UNPAID',
        mpesaRef: delivery.mpesaRef || payment?.mpesaRef || null,
        paidPhone: payment?.phone || delivery.customerPhone || null,
        paidAt: payment?.paidAt || null,
        payerName: retailer?.name || delivery.customerName || 'Business Owner',
        payment
      });
    }
    const d = jRead();
    const delivery = d.deliveries.find(x => x.id === id);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    const payment = (d.payments || []).filter(p => p.deliveryId === id).slice(-1)[0];
    const retailer = (d.users || []).find(u => u.id === delivery.retailerId);

    // Remote callback sync (syncs callbacks landing on live domain grp.empresmabati.co.ke with local dev)
    if (delivery.paymentStatus !== 'PAID' && process.env.MPESA_CALLBACK_URL && process.env.MPESA_CALLBACK_URL.startsWith('http')) {
      try {
        const u = new URL(process.env.MPESA_CALLBACK_URL);
        const remoteStatusUrl = `${u.origin}/api/mpesa/status/${id}`;
        if (!remoteStatusUrl.includes('localhost') && !remoteStatusUrl.includes('127.0.0.1')) {
          const remoteRes = await safeFetch(remoteStatusUrl);
          const remoteData = await remoteRes.json().catch(() => ({}));
          if (remoteData && remoteData.paid) {
            delivery.paymentStatus = 'PAID';
            delivery.mpesaRef = remoteData.mpesaRef || 'PAID';
            if (payment) {
              payment.status = 'PAID';
              payment.mpesaRef = remoteData.mpesaRef || 'PAID';
              payment.paidAt = remoteData.paidAt || now();
            }
            jWrite(d);
            return res.json({
              paid: true,
              paymentStatus: 'PAID',
              mpesaRef: delivery.mpesaRef,
              paidPhone: remoteData.paidPhone || delivery.customerPhone,
              paidAt: remoteData.paidAt || now(),
              payerName: retailer?.name || delivery.customerName || 'Business Owner',
              payment
            });
          }
        }
      } catch(e) {}
    }

    return res.json({
      paid: delivery.paymentStatus === 'PAID',
      paymentStatus: delivery.paymentStatus || 'UNPAID',
      mpesaRef: delivery.paymentStatus === 'PAID' ? (delivery.mpesaRef || payment?.mpesaRef || 'CONFIRMED') : null,
      paidPhone: payment?.paidPhone || payment?.phone || delivery.customerPhone || null,
      paidAt: payment?.paidAt || null,
      payerName: retailer?.name || delivery.customerName || 'Business Owner',
      payment
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  MPESA — CALLBACK (Safaricom calls this after payment)
// ══════════════════════════════════════════════════════════════════════════
const LOG_FILE = path.join(__dirname, 'mpesa_callback.log');

function logMpesaCallback(data) {
  const timestamp = new Date().toISOString();
  const logEntry = `\n==================== [ ${timestamp} ] ====================\n` + 
                   (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + 
                   `\n==========================================================\n`;
  fs.appendFile(LOG_FILE, logEntry, (err) => {
    if (err) console.error('Failed to write to mpesa_callback.log:', err);
  });
}

app.get('/api/mpesa/callback-logs', (req, res) => {
  if (fs.existsSync(LOG_FILE)) {
    const logs = fs.readFileSync(LOG_FILE, 'utf8');
    res.type('text/plain').send(logs);
  } else {
    res.send('No callback logs recorded yet.');
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const body = req.body;
    console.log('Mpesa Callback Received:', JSON.stringify(body, null, 2));
    
    // Save to dedicated log file on HostAfrica server
    logMpesaCallback(body);

    const stk = body?.Body?.stkCallback;
    const code = stk?.ResultCode;
    const checkoutRequestId = stk?.CheckoutRequestID;
    
    if (stk && checkoutRequestId) {
      const meta = stk.CallbackMetadata?.Item || [];
      const get = name => meta.find(i => i.Name === name)?.Value;
      const mpesaRef = get('MpesaReceiptNumber') || null;
      const amount = get('Amount') || null;
      const rawDate = get('TransactionDate');
      const paidAt = rawDate ? String(rawDate) : now();
      const paidPhone = get('PhoneNumber') ? String(get('PhoneNumber')) : null;

      if (useMySQL) {
        if (code === 0) {
          const [[payment]] = await db.query('SELECT deliveryId FROM payments WHERE checkoutRequestId=?', [checkoutRequestId]);
          await db.query(
            `UPDATE payments SET status='PAID', mpesaRef=?, amount=COALESCE(?, amount), paidAt=?, phone=COALESCE(?, phone) WHERE checkoutRequestId=?`,
            [mpesaRef, amount, paidAt, paidPhone, checkoutRequestId]
          );
          if (payment?.deliveryId) {
            await db.query("UPDATE deliveries SET paymentStatus='PAID', mpesaRef=? WHERE id=?", [mpesaRef, payment.deliveryId]);
          }
        } else {
          await db.query(
            `UPDATE payments SET status='FAILED', failReason=? WHERE checkoutRequestId=?`,
            [stk?.ResultDesc || 'Payment failed', checkoutRequestId]
          );
        }
      } else {
        const d = jRead();
        if (!d.payments) d.payments = [];
        const payment = d.payments.find(p => p.checkoutRequestId === checkoutRequestId);
        if (payment) {
          if (code === 0) {
            payment.status = 'PAID';
            payment.mpesaRef = mpesaRef;
            payment.amount = amount || payment.amount;
            payment.paidAt = paidAt;
            payment.paidPhone = paidPhone || payment.phone;
            const delivery = d.deliveries.find(x => x.id === payment.deliveryId);
            if (delivery) {
              delivery.paymentStatus = 'PAID';
              delivery.mpesaRef = payment.mpesaRef;
            }
          } else {
            payment.status = 'FAILED';
            payment.failReason = stk?.ResultDesc || 'Payment failed';
          }
          jWrite(d);
        }
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  MPESA — SIMULATE SUCCESS (Demo / Testing Sandbox Helper)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/mpesa/simulate-success', async (req, res) => {
  try {
    const { deliveryId, phone } = req.body;
    if (!deliveryId) return res.status(400).json({ error: 'deliveryId is required' });
    const mpesaRef = 'SIM' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const t = now();

    if (useMySQL) {
      await db.query("UPDATE deliveries SET paymentStatus='PAID', mpesaRef=? WHERE id=?", [mpesaRef, deliveryId]);
      await db.query(
        "UPDATE payments SET status='PAID', mpesaRef=?, paidAt=?, phone=COALESCE(?, phone) WHERE deliveryId=?",
        [mpesaRef, t, phone || null, deliveryId]
      );
      return res.json({ success: true, mpesaRef, message: `Payment for ${deliveryId} simulated as PAID!` });
    }

    const d = jRead();
    const delivery = d.deliveries.find(x => x.id === deliveryId);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    delivery.paymentStatus = 'PAID';
    delivery.mpesaRef = mpesaRef;
    if (!d.payments) d.payments = [];
    let p = d.payments.find(x => x.deliveryId === deliveryId);
    if (!p) {
      p = { id: 'PAY-' + Date.now(), deliveryId, amount: 2, status: 'PAID', createdAt: t };
      d.payments.push(p);
    }
    p.status = 'PAID';
    p.mpesaRef = mpesaRef;
    p.paidAt = t;
    if (phone) p.phone = phone;
    jWrite(d);
    res.json({ success: true, mpesaRef, message: `Payment for ${deliveryId} simulated as PAID!` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  if (useMySQL) {
    try { await db.query('SELECT 1'); res.json({ ok: true, storage: 'MySQL', host: process.env.DB_HOST }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  } else {
    res.json({ ok: true, storage: 'JSON file (local dev mode)' });
  }
});

// ── SPA fallback ─────────────────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'))
);

// ── Boot ──────────────────────────────────────────────────────────────────
initStorage().then(() => {
  app.listen(PORT, () => console.log(`🚀 Reflex running at http://localhost:${PORT} [${useMySQL ? 'MySQL' : 'JSON'}]`));
});

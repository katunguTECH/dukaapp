// server.js - Complete DukaApp Server with Permanent User Registration
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const axios = require('axios');
const app = express();

// ============================================================
// M-PESA DARAJA API CONFIGURATION (YOUR CREDENTIALS)
// ============================================================

const MPESA_CONFIG = {
  consumerKey: "4L1I9rLFAU0Xv3d3RvFcEopc8e1VNILirvDhUkeBZBp3nx60",
  consumerSecret: "6mkKjD05Afqxl16tg5gRFG7p5f6tpfJzmbQVJyrGtetomny7lrpWJ7eEh5ekwcgY",
  passkey: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  shortcode: "174379",
  environment: "sandbox",
  callbackUrl: "https://dukaapp.online/mpesa-callback"
};

const MPESA_API_BASE = MPESA_CONFIG.environment === "sandbox" 
  ? "https://sandbox.safaricom.co.ke" 
  : "https://api.safaricom.co.ke";

// Store pending payments in memory
const pendingPayments = {};

// ============================================================
// ADMIN PASSWORD PROTECTION
// ============================================================

const ADMIN_PASSWORD = "Dallas123!";

function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Access"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');
  
  if (password === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ error: 'Invalid password' });
  }
}

// ============================================================
// DATABASE SETUP
// ============================================================

let db;

async function initDatabase() {
  db = await open({
    filename: './dukaapp.db',
    driver: sqlite3.Database
  });
  
  await db.exec(`
    -- Users table (basic user info)
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      business_name TEXT,
      business_type TEXT,
      location TEXT,
      registered INTEGER DEFAULT 0,
      step TEXT DEFAULT 'none',
      trial_start_date DATETIME,
      trial_end_date DATETIME,
      subscription_status TEXT DEFAULT 'trial',
      subscription_end_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Transactions table (sales and expenses)
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      amount REAL,
      type TEXT,
      category TEXT,
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Payments table (STK Push payments)
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      amount REAL,
      checkout_request_id TEXT,
      mpesa_receipt TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Stock products table
    CREATE TABLE IF NOT EXISTS stock_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      reorder_level REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(phone, product_name)
    );
    
    -- Stock transactions table
    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      product_id INTEGER,
      transaction_type TEXT CHECK(transaction_type IN ('add', 'use', 'adjust')),
      quantity REAL NOT NULL,
      reason TEXT,
      previous_quantity REAL,
      new_quantity REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES stock_products(id)
    );
    
    -- SUBSCRIBERS TABLE - Comprehensive tracking
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      business_name TEXT,
      business_type TEXT,
      location TEXT,
      subscription_status TEXT DEFAULT 'trial',
      status_history TEXT,
      trial_start_date DATETIME,
      trial_end_date DATETIME,
      subscription_start_date DATETIME,
      subscription_end_date DATETIME,
      last_payment_date DATETIME,
      last_payment_amount REAL,
      total_paid REAL DEFAULT 0,
      cancelled_date DATETIME,
      cancellation_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Payment history table
    CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber_id INTEGER,
      phone TEXT,
      amount REAL,
      payment_method TEXT DEFAULT 'mpesa_stk',
      mpesa_receipt TEXT,
      checkout_request_id TEXT,
      status TEXT DEFAULT 'pending',
      payment_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
    );
    
    -- Trial tracking table
    CREATE TABLE IF NOT EXISTS trial_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      trial_start_date DATETIME NOT NULL,
      trial_end_date DATETIME NOT NULL,
      trial_status TEXT DEFAULT 'active',
      converted_to_paid INTEGER DEFAULT 0,
      conversion_date DATETIME,
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Cancellation tracking table
    CREATE TABLE IF NOT EXISTS cancellation_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      cancellation_date DATETIME NOT NULL,
      cancellation_reason TEXT,
      subscription_status_at_cancellation TEXT,
      days_used INTEGER,
      amount_paid_before_cancellation REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Database ready');
  
  // Run initial subscription check
  await checkExpiredTrials();
}

initDatabase();

// ============================================================
// M-PESA HELPER FUNCTIONS
// ============================================================

async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  
  try {
    const response = await axios.get(
      `${MPESA_API_BASE}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );
    console.log('✅ M-Pesa access token obtained');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Error getting M-Pesa token:', error.response?.data || error.message);
    return null;
  }
}

function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`
  ).toString('base64');
  return { password, timestamp };
}

function formatPhoneForMpesa(phoneNumber) {
  let phone = phoneNumber.replace('whatsapp:', '').replace(/\+/g, '');
  phone = phone.replace(/\D/g, '');
  
  if (phone.startsWith('0')) phone = '254' + phone.substring(1);
  else if (phone.startsWith('7')) phone = '254' + phone;
  else if (phone.startsWith('1')) phone = '254' + phone;
  
  return phone;
}

async function initiateSTKPush(phoneNumber, amount, accountReference, transactionDesc) {
  const accessToken = await getMpesaAccessToken();
  if (!accessToken) return { success: false, error: "Failed to get access token" };
  
  const { password, timestamp } = generateMpesaPassword();
  const formattedPhone = formatPhoneForMpesa(phoneNumber);
  
  console.log(`📱 Initiating STK Push to ${formattedPhone} for KES ${amount}`);
  
  const data = {
    BusinessShortCode: MPESA_CONFIG.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: formattedPhone,
    PartyB: MPESA_CONFIG.shortcode,
    PhoneNumber: formattedPhone,
    CallBackURL: MPESA_CONFIG.callbackUrl,
    AccountReference: accountReference.substring(0, 12),
    TransactionDesc: transactionDesc.substring(0, 13)
  };
  
  try {
    const response = await axios.post(
      `${MPESA_API_BASE}/mpesa/stkpush/v1/processrequest`,
      data,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    
    if (response.data.ResponseCode === '0') {
      return { success: true, checkoutRequestId: response.data.CheckoutRequestID };
    } else {
      return { success: false, error: response.data.ResponseDescription || "STK Push failed" };
    }
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================
// SUBSCRIBER MANAGEMENT FUNCTIONS (PERMANENT STORAGE)
// ============================================================

async function recordNewSubscriber(phone, businessName, businessType, location) {
  const now = new Date();
  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + 14);
  
  // First, update the users table
  await db.run(`
    UPDATE users SET 
      business_name = ?, business_type = ?, location = ?, 
      registered = 1, trial_start_date = ?, trial_end_date = ?
    WHERE phone = ?
  `, businessName, businessType, location, now.toISOString(), trialEndDate.toISOString(), phone);
  
  // Check if subscriber already exists
  const existing = await db.get('SELECT * FROM subscribers WHERE phone = ?', phone);
  
  if (!existing) {
    await db.run(`
      INSERT INTO subscribers (
        phone, business_name, business_type, location, 
        subscription_status, trial_start_date, trial_end_date,
        status_history, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'trial', ?, ?, ?, ?, ?)
    `, phone, businessName, businessType, location, now.toISOString(), trialEndDate.toISOString(), 
       JSON.stringify([{ status: 'trial', date: now.toISOString(), note: 'User registered' }]),
       now.toISOString(), now.toISOString());
    
    await db.run(`
      INSERT INTO trial_tracking (phone, trial_start_date, trial_end_date, trial_status)
      VALUES (?, ?, ?, 'active')
    `, phone, now.toISOString(), trialEndDate.toISOString());
    
    console.log(`📊 New subscriber recorded: ${phone} - ${businessName}`);
  } else {
    // Update existing subscriber
    await db.run(`
      UPDATE subscribers SET 
        business_name = ?, business_type = ?, location = ?,
        trial_start_date = ?, trial_end_date = ?, updated_at = ?
      WHERE phone = ?
    `, businessName, businessType, location, now.toISOString(), trialEndDate.toISOString(), now.toISOString(), phone);
    console.log(`📊 Subscriber updated: ${phone}`);
  }
}

async function updateSubscriberStatus(phone, newStatus, note = '') {
  const now = new Date();
  const subscriber = await db.get('SELECT * FROM subscribers WHERE phone = ?', phone);
  
  if (subscriber) {
    let statusHistory = [];
    try { statusHistory = JSON.parse(subscriber.status_history || '[]'); } catch(e) {}
    
    statusHistory.push({ status: newStatus, date: now.toISOString(), note: note });
    
    const updates = {
      subscription_status: newStatus,
      status_history: JSON.stringify(statusHistory),
      updated_at: now.toISOString()
    };
    
    if (newStatus === 'active') {
      const subEndDate = new Date();
      subEndDate.setDate(subEndDate.getDate() + 30);
      updates.subscription_start_date = now.toISOString();
      updates.subscription_end_date = subEndDate.toISOString();
    }
    
    if (newStatus === 'cancelled') {
      updates.cancelled_date = now.toISOString();
      await db.run(`
        INSERT INTO cancellation_tracking (
          phone, cancellation_date, subscription_status_at_cancellation, 
          days_used, amount_paid_before_cancellation
        ) VALUES (?, ?, ?, ?, ?)
      `, phone, now.toISOString(), subscriber.subscription_status, 
         Math.ceil((now - new Date(subscriber.created_at)) / (1000 * 60 * 60 * 24)),
         subscriber.total_paid || 0);
    }
    
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), phone];
    await db.run(`UPDATE subscribers SET ${setClause} WHERE phone = ?`, ...values);
    console.log(`📊 Subscriber ${phone} status updated to: ${newStatus}`);
  }
}

async function recordPayment(phone, amount, mpesaReceipt, checkoutRequestId) {
  const now = new Date();
  const subscriber = await db.get('SELECT * FROM subscribers WHERE phone = ?', phone);
  
  if (subscriber) {
    await db.run(`
      INSERT INTO payment_history (
        subscriber_id, phone, amount, mpesa_receipt, 
        checkout_request_id, status, payment_date
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `, subscriber.id, phone, amount, mpesaReceipt, checkoutRequestId, now.toISOString());
    
    const newTotal = (subscriber.total_paid || 0) + amount;
    await db.run(`UPDATE subscribers SET total_paid = ?, last_payment_date = ?, last_payment_amount = ? WHERE phone = ?`, 
                 newTotal, now.toISOString(), amount, phone);
    console.log(`💰 Payment recorded: ${phone} - KES ${amount}`);
  }
}

async function markTrialConverted(phone) {
  const now = new Date();
  await db.run(`
    UPDATE trial_tracking 
    SET converted_to_paid = 1, conversion_date = ?, trial_status = 'converted'
    WHERE phone = ? AND converted_to_paid = 0
  `, now.toISOString(), phone);
  console.log(`📊 Trial converted to paid: ${phone}`);
}

async function checkExpiredTrials() {
  const now = new Date().toISOString();
  const expiredUsers = await db.all(
    `SELECT * FROM users WHERE subscription_status = 'trial' AND trial_end_date <= ?`,
    now
  );
  
  for (const user of expiredUsers) {
    await db.run(`UPDATE users SET subscription_status = 'expired' WHERE phone = ?`, user.phone);
    await updateSubscriberStatus(user.phone, 'expired', 'Trial expired without payment');
    console.log(`⚠️ Trial expired for ${user.phone}`);
  }
}

async function activateSubscription(phone, paymentAmount, mpesaReceipt, checkoutRequestId) {
  const subscriptionEndDate = new Date();
  subscriptionEndDate.setDate(subscriptionEndDate.getDate() + 30);
  
  await db.run(`UPDATE users SET subscription_status = 'active', subscription_end_date = ?,
                trial_start_date = NULL, trial_end_date = NULL WHERE phone = ?`,
                subscriptionEndDate.toISOString(), phone);
  
  await db.run(`UPDATE payments SET status = 'completed', mpesa_receipt = ? WHERE checkout_request_id = ?`,
                mpesaReceipt, checkoutRequestId);
  
  await recordPayment(phone, paymentAmount, mpesaReceipt, checkoutRequestId);
  await updateSubscriberStatus(phone, 'active', `Payment of KES ${paymentAmount} received. Receipt: ${mpesaReceipt}`);
  await markTrialConverted(phone);
  
  console.log(`✅ Subscription activated for ${phone}`);
}

// ============================================================
// USER MANAGEMENT FUNCTIONS (PERMANENT)
// ============================================================

async function getUser(phone) {
  let user = await db.get('SELECT * FROM users WHERE phone = ?', phone);
  
  if (!user) {
    const now = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);
    
    await db.run(`
      INSERT INTO users (
        phone, step, trial_start_date, trial_end_date, 
        subscription_status, created_at
      ) VALUES (?, ?, ?, ?, 'trial', ?)
    `, phone, 'none', now.toISOString(), trialEndDate.toISOString(), now.toISOString());
    
    user = await db.get('SELECT * FROM users WHERE phone = ?', phone);
    console.log(`🆕 Created new user: ${phone}`);
  }
  return user;
}

async function updateUser(phone, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  await db.run(`UPDATE users SET ${setClause} WHERE phone = ?`, ...values, phone);
}

async function getSubscriptionStatus(phone) {
  const user = await db.get(`SELECT subscription_status, trial_end_date, subscription_end_date FROM users WHERE phone = ?`, phone);
  if (!user) return { status: 'no_account' };
  
  if (user.subscription_status === 'trial' && user.trial_end_date) {
    const daysLeft = Math.ceil((new Date(user.trial_end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { status: 'trial', daysLeft: Math.max(0, daysLeft), endDate: user.trial_end_date };
  }
  if (user.subscription_status === 'active' && user.subscription_end_date) {
    const daysLeft = Math.ceil((new Date(user.subscription_end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { status: 'active', daysLeft: Math.max(0, daysLeft), endDate: user.subscription_end_date };
  }
  return { status: user.subscription_status || 'unknown' };
}

// ============================================================
// STOCK MANAGEMENT FUNCTIONS
// ============================================================

async function getProductStock(phone, productName) {
  return await db.get('SELECT * FROM stock_products WHERE phone = ? AND LOWER(product_name) = LOWER(?)', phone, productName);
}

async function addStockProduct(phone, productName, quantity, unit = 'pcs', reorderLevel = 0) {
  const existing = await getProductStock(phone, productName);
  
  if (existing) {
    const newQuantity = existing.quantity + quantity;
    await db.run(`UPDATE stock_products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ? AND LOWER(product_name) = LOWER(?)`,
                  newQuantity, phone, productName);
    await db.run(`INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, previous_quantity, new_quantity)
                  VALUES (?, ?, 'add', ?, ?, ?)`, phone, existing.id, quantity, existing.quantity, newQuantity);
    return { success: true, product: productName, oldQty: existing.quantity, newQty: newQuantity };
  } else {
    const result = await db.run(`INSERT INTO stock_products (phone, product_name, quantity, unit, reorder_level) VALUES (?, ?, ?, ?, ?)`,
                                phone, productName, quantity, unit, reorderLevel);
    await db.run(`INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, previous_quantity, new_quantity)
                  VALUES (?, ?, 'add', ?, 0, ?)`, phone, result.lastID, quantity, quantity);
    return { success: true, product: productName, newQty: quantity, isNew: true };
  }
}

async function useStockProduct(phone, productName, quantity, reason = 'sale') {
  const product = await getProductStock(phone, productName);
  if (!product) return { success: false, error: `Product "${productName}" not found` };
  if (product.quantity < quantity) return { success: false, error: `Insufficient stock. Available: ${product.quantity} ${product.unit}` };
  
  const newQuantity = product.quantity - quantity;
  await db.run(`UPDATE stock_products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ? AND LOWER(product_name) = LOWER(?)`,
                newQuantity, phone, productName);
  await db.run(`INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, reason, previous_quantity, new_quantity)
                VALUES (?, ?, 'use', ?, ?, ?, ?)`, phone, product.id, quantity, reason, product.quantity, newQuantity);
  return { success: true, product: productName, usedQty: quantity, remainingQty: newQuantity, unit: product.unit };
}

async function listStockProducts(phone) {
  return await db.all('SELECT product_name, quantity, unit, reorder_level FROM stock_products WHERE phone = ? ORDER BY product_name', phone);
}

async function getLowStockProducts(phone) {
  return await db.all('SELECT product_name, quantity, unit, reorder_level FROM stock_products WHERE phone = ? AND quantity <= reorder_level ORDER BY quantity ASC', phone);
}

// ============================================================
// ADMIN API ENDPOINTS (Password Protected)
// ============================================================

app.use('/api/admin', adminAuth);

app.get('/api/admin/subscribers/stats', async (req, res) => {
  try {
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_subscribers,
        SUM(CASE WHEN subscription_status = 'trial' THEN 1 ELSE 0 END) as active_trials,
        SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) as active_paid,
        SUM(CASE WHEN subscription_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN subscription_status = 'expired' THEN 1 ELSE 0 END) as expired,
        SUM(total_paid) as total_revenue
      FROM subscribers
    `);
    const trialMetrics = await db.get(`
      SELECT 
        COUNT(*) as total_trials,
        SUM(CASE WHEN converted_to_paid = 1 THEN 1 ELSE 0 END) as converted_trials,
        ROUND(CAST(SUM(CASE WHEN converted_to_paid = 1 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100, 2) as conversion_rate
      FROM trial_tracking
    `);
    res.json({ success: true, stats, trial_metrics: trialMetrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/subscribers', async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    let query = 'SELECT * FROM subscribers WHERE 1=1';
    const params = [];
    if (status && status !== 'all') { query += ' AND subscription_status = ?'; params.push(status); }
    if (startDate) { query += ' AND created_at >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND created_at <= ?'; params.push(endDate); }
    query += ' ORDER BY created_at DESC';
    const subscribers = await db.all(query, params);
    res.json({ success: true, subscribers, count: subscribers.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/subscribers/export', async (req, res) => {
  try {
    const subscribers = await db.all('SELECT * FROM subscribers ORDER BY created_at DESC');
    const headers = ['Phone', 'Business Name', 'Business Type', 'Location', 'Status', 'Trial Start', 'Trial End', 'Subscription Start', 'Subscription End', 'Total Paid', 'Created At'];
    const csvRows = [headers];
    for (const sub of subscribers) {
      csvRows.push([
        sub.phone, sub.business_name || '', sub.business_type || '', sub.location || '',
        sub.subscription_status, sub.trial_start_date || '', sub.trial_end_date || '',
        sub.subscription_start_date || '', sub.subscription_end_date || '', sub.total_paid || 0, sub.created_at
      ]);
    }
    const csvContent = csvRows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=subscribers_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// MIDDLEWARE & STATIC FILES
// ============================================================

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('.'));

// ============================================================
// HEALTH CHECK ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'DukaApp server is running', timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/test', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// ============================================================
// ADMIN DASHBOARD PAGE
// ============================================================

app.get('/admin-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// ============================================================
// M-PESA CALLBACK ENDPOINT
// ============================================================

app.post('/mpesa-callback', async (req, res) => {
  console.log('📞 M-Pesa callback received');
  try {
    const stkCallback = req.body.Body?.stkCallback;
    if (stkCallback) {
      const checkoutRequestId = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      
      if (resultCode === 0) {
        const mpesaReceipt = stkCallback.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
        const amount = stkCallback.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value;
        const payment = await db.get('SELECT * FROM payments WHERE checkout_request_id = ? AND status = "pending"', checkoutRequestId);
        
        if (payment) {
          await activateSubscription(payment.phone, amount, mpesaReceipt, checkoutRequestId);
          console.log(`✅ Payment confirmed for ${payment.phone}: KES ${amount}`);
        } else if (pendingPayments[checkoutRequestId]) {
          await activateSubscription(pendingPayments[checkoutRequestId].phone, amount, mpesaReceipt, checkoutRequestId);
          delete pendingPayments[checkoutRequestId];
        }
      }
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 1, ResultDesc: "Error" });
  }
});

// ============================================================
// MAIN LANDING PAGE
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/start-trial', (req, res) => {
  res.redirect('https://wa.me/14155238886?text=start');
});

app.get('/agent-signup', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Become a DukaApp Agent</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; margin: 0; }
      .card { background: white; border-radius: 30px; padding: 40px; max-width: 500px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); }
      h1 { color: #333; }
      .commission { background: #f0fdf4; border-radius: 20px; padding: 20px; margin: 20px 0; }
      .commission h3 { color: #28a745; font-size: 28px; margin: 0; }
      .btn { background: #25D366; color: white; padding: 15px 30px; border-radius: 50px; text-decoration: none; display: inline-block; font-weight: 600; margin-top: 20px; }
    </style>
    </head>
    <body>
      <div class="card"><h1>🚀 Become a DukaApp Agent</h1><p class="subtitle">Earn KES 200 per shop + 10% monthly recurring commission</p>
      <div class="commission"><h3>KES 200</h3><p>per shop signup bonus</p><p style="font-size: 14px;">+ 10% of subscription (KES 30/month for 3 months)</p></div>
      <p>To become an agent, send "agent" to our WhatsApp number.</p>
      <a href="https://wa.me/14155238886?text=agent" class="btn">Start on WhatsApp →</a></div>
    </body>
    </html>
  `);
});

// ============================================================
// WHATSAPP WEBHOOK - MAIN HANDLER WITH PERMANENT REGISTRATION
// ============================================================

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const userPhone = req.body.From || 'unknown';
  
  console.log(`📩 Message from ${userPhone}: "${incomingMsg}"`);
  
  let user = await getUser(userPhone);
  const subscription = await getSubscriptionStatus(userPhone);
  
  // Expired subscription check
  if (subscription.status === 'expired' && !['pay now', 'pay', 'start'].includes(incomingMsg)) {
    twiml.message(`⚠️ *Subscription Expired*\n\nYour 14-day free trial has ended.\n\nPlease pay KES 299 to continue using DukaApp.\n\nReply *PAY NOW* to make payment via M-Pesa STK Push.`);
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // PAY NOW COMMAND
  if (incomingMsg === 'pay now' || incomingMsg === 'pay') {
    if (subscription.status === 'active') {
      const endDate = new Date(subscription.endDate).toLocaleDateString();
      twiml.message(`✅ *Subscription Active*\n\nYour subscription is active until ${endDate}.\n\nNo payment needed at this time.`);
      res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
    }
    
    twiml.message(`💰 *Processing Payment*\n\nPlease wait while we initiate your M-Pesa STK Push.\n\n💳 Amount: KES 299\n🏪 Service: DukaApp Subscription\n\nYou will receive a popup on your phone shortly.\n\nEnter your PIN to complete payment.`);
    
    const result = await initiateSTKPush(userPhone, 299, `DukaApp_${userPhone.slice(-8)}`, 'DukaApp Subscription');
    
    if (result.success) {
      await db.run(`INSERT INTO payments (phone, amount, checkout_request_id, status) VALUES (?, ?, ?, 'pending')`, userPhone, 299, result.checkoutRequestId);
      pendingPayments[result.checkoutRequestId] = { phone: userPhone, amount: 299 };
      console.log(`💰 STK Push initiated for ${userPhone}`);
    } else {
      console.error(`❌ STK Push failed for ${userPhone}: ${result.error}`);
    }
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // REGISTERED USER COMMANDS
  if (user.registered === 1) {
    // HELP
    if (incomingMsg === 'help') {
      let subInfo = subscription.status === 'trial' ? `\n🎟️ *Trial: ${subscription.daysLeft} days remaining*` : 
                    subscription.status === 'active' ? `\n✅ *Active: ${subscription.daysLeft} days remaining*` : '';
      twiml.message(`📖 *DUKAAPP COMMANDS*${subInfo}\n\n━━━━━━━━━━━━━━━━━━━━\n💰 *Sales & Expenses*\n━━━━━━━━━━━━━━━━━━━━\n• sale [amount]\n• expense [amount]\n• cash [amount]\n\n📦 *Stock Management*\n━━━━━━━━━━━━━━━━━━━━\n• stock [product]\n• addstock [product] [qty]\n• usestock [product] [qty]\n• liststock\n• lowstock\n\n📊 *Reports*\n━━━━━━━━━━━━━━━━━━━━\n• profit\n• status\n\n💳 *Subscription*\n━━━━━━━━━━━━━━━━━━━━\n• pay now\n\nExamples: sale 1500, addstock sugar 50, profit, pay now`);
    }
    // STATUS
    else if (incomingMsg === 'status') {
      const products = await listStockProducts(userPhone);
      let subInfo = subscription.status === 'trial' ? `🎟️ Free Trial: ${subscription.daysLeft} days remaining` :
                    subscription.status === 'active' ? `✅ Subscription Active: ${subscription.daysLeft} days remaining` : `⚠️ Subscription Expired - Send PAY NOW to renew`;
      twiml.message(`📋 *BUSINESS STATUS*\n\n🏪 Business: ${user.business_name}\n📂 Type: ${user.business_type}\n📍 Location: ${user.location}\n━━━━━━━━━━━━━━━━━━━━\n${subInfo}\n━━━━━━━━━━━━━━━━━━━━\n📦 Products in stock: ${products.length}\n\nType "help" for all commands.`);
    }
    // STOCK commands
    else if (incomingMsg.startsWith('stock')) {
      const parts = incomingMsg.split(' ');
      const productName = parts.slice(1).join(' ');
      if (!productName) {
        const products = await listStockProducts(userPhone);
        if (products.length === 0) twiml.message(`📦 *No products in inventory*\n\nAdd products with: addstock [product] [quantity]\nExample: addstock sugar 50`);
        else {
          let stockList = `📦 *YOUR INVENTORY*\n\n`;
          for (const p of products) stockList += `${p.quantity <= p.reorder_level ? '⚠️' : '✅'} *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
          twiml.message(stockList);
        }
      } else {
        const product = await getProductStock(userPhone, productName);
        if (!product) twiml.message(`❌ Product "${productName}" not found.\n\nAdd it with: addstock ${productName} [quantity]`);
        else twiml.message(`📦 *${product.product_name.toUpperCase()}*\n\n📊 Current stock: ${product.quantity} ${product.unit}\nStatus: ${product.quantity <= product.reorder_level ? '⚠️ LOW STOCK' : '✅ In stock'}`);
      }
    }
    else if (incomingMsg.startsWith('addstock')) {
      const parts = incomingMsg.split(' ');
      if (parts.length < 3) twiml.message(`📦 *Add Stock*\n\nType: addstock [product] [quantity]\nExample: addstock sugar 50`);
      else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        if (isNaN(quantity) || quantity <= 0) twiml.message(`❌ Invalid quantity. Enter a valid number.`);
        else {
          const result = await addStockProduct(userPhone, productName, quantity);
          if (result.success) twiml.message(`✅ ${result.isNew ? 'New product added!' : 'Stock updated!'}\n\n📦 ${productName}: ${result.isNew ? result.newQty : `${result.oldQty} → ${result.newQty}`} pcs`);
        }
      }
    }
    else if (incomingMsg.startsWith('usestock')) {
      const parts = incomingMsg.split(' ');
      if (parts.length < 3) twiml.message(`📦 *Use Stock*\n\nType: usestock [product] [quantity]\nExample: usestock sugar 5`);
      else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        if (isNaN(quantity) || quantity <= 0) twiml.message(`❌ Invalid quantity.`);
        else {
          const result = await useStockProduct(userPhone, productName, quantity);
          if (result.success) twiml.message(`✅ *Stock used!*\n\n📦 ${result.product}: Used ${result.usedQty} pcs\n📊 Remaining: ${result.remainingQty} pcs`);
          else twiml.message(`❌ ${result.error}`);
        }
      }
    }
    else if (incomingMsg === 'liststock') {
      const products = await listStockProducts(userPhone);
      if (products.length === 0) twiml.message(`📦 *No products in inventory*\n\nAdd products with: addstock [product] [quantity]`);
      else {
        let stockList = `📦 *COMPLETE INVENTORY*\n\n`;
        for (const p of products) stockList += `• *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
        stockList += `\nTotal: ${products.length} products`;
        twiml.message(stockList);
      }
    }
    else if (incomingMsg === 'lowstock') {
      const lowProducts = await getLowStockProducts(userPhone);
      if (lowProducts.length === 0) twiml.message(`✅ *No low stock items*\n\nAll products are well stocked.`);
      else {
        let alertMsg = `⚠️ *LOW STOCK ALERT*\n\n`;
        for (const p of lowProducts) alertMsg += `📦 ${p.product_name}: ${p.quantity} ${p.unit} left\n`;
        alertMsg += `\nRestock with: addstock [product] [quantity]`;
        twiml.message(alertMsg);
      }
    }
    // FINANCIAL commands
    else if (incomingMsg.startsWith('sale')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) { await db.run(`INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'sale')`, userPhone, amount); twiml.message(`✅ *Sale Recorded!* KES ${amount}`); }
      else twiml.message(`📊 *Record a Sale*\n\nType: sale [amount]\nExample: sale 1500`);
    }
    else if (incomingMsg.startsWith('expense')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) { await db.run(`INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'expense')`, userPhone, amount); twiml.message(`✅ *Expense Recorded!* KES ${amount}`); }
      else twiml.message(`💸 *Record an Expense*\n\nType: expense [amount]\nExample: expense 500`);
    }
    else if (incomingMsg.startsWith('cash')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) { await db.run(`INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'cash_sale')`, userPhone, amount); twiml.message(`✅ *Cash Sale Recorded!* KES ${amount}`); }
      else twiml.message(`💵 *Record a Cash Sale*\n\nType: cash [amount]\nExample: cash 1000`);
    }
    else if (incomingMsg === 'profit') {
      const today = new Date().toISOString().split('T')[0];
      const sales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type IN ('sale', 'cash_sale') AND date = ?`, userPhone, today);
      const expenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date = ?`, userPhone, today);
      const totalSales = sales?.total || 0, totalExpenses = expenses?.total || 0, profit = totalSales - totalExpenses;
      twiml.message(`📊 *TODAY'S PROFIT*\n\n💰 Sales: KES ${totalSales}\n💸 Expenses: KES ${totalExpenses}\n━━━━━━━━━━━━━━━━━━━━\n📈 PROFIT: KES ${profit}`);
    }
    else if (incomingMsg === 'agent') {
      twiml.message(`🤝 *Become a DukaApp Agent*\n\n• KES 200 per shop you sign up\n• 10% recurring commission\n\nStart here: https://dukaapp.online/agent-signup`);
    }
    else {
      twiml.message(`❌ Command not recognized.\n\nType *help* to see all commands.\n\nExamples:\n• sale 1500\n• addstock sugar 50\n• profit\n• pay now`);
    }
    
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // ============================================================
  // REGISTRATION FLOW (Only for NEW users)
  // ============================================================
  
  // Step 2: Waiting for business name
  if (user.step === 'waiting_for_business_name') {
    await updateUser(userPhone, { business_name: incomingMsg, step: 'waiting_for_business_type' });
    twiml.message(`Great! What type of business do you run?\n\nExamples: Retail Shop, Grocery, Hardware, Restaurant, Salon, Boutique, etc.\n\nType your business type.`);
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // Step 3: Waiting for business type
  if (user.step === 'waiting_for_business_type') {
    await updateUser(userPhone, { business_type: incomingMsg, step: 'waiting_for_location' });
    twiml.message(`Where is your business located?\n\nExamples: Nairobi, Mombasa, Kisumu, Nakuru, etc.\n\nType your location.`);
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // Step 4: Waiting for location - Complete registration (PERMANENT STORAGE)
  if (user.step === 'waiting_for_location') {
    // Update users table
    await updateUser(userPhone, { 
      location: incomingMsg, 
      registered: 1, 
      step: 'none'
    });
    
    // Get the updated user data
    user = await getUser(userPhone);
    
    // CRITICAL: Record in subscribers table for permanent tracking
    const now = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);
    
    // Check if subscriber already exists
    const existingSubscriber = await db.get('SELECT * FROM subscribers WHERE phone = ?', userPhone);
    
    if (!existingSubscriber) {
      await db.run(`
        INSERT INTO subscribers (
          phone, business_name, business_type, location, 
          subscription_status, trial_start_date, trial_end_date,
          status_history, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'trial', ?, ?, ?, ?, ?)
      `, userPhone, user.business_name, user.business_type, incomingMsg, 
         now.toISOString(), trialEndDate.toISOString(), 
         JSON.stringify([{ status: 'trial', date: now.toISOString(), note: 'User registered' }]),
         now.toISOString(), now.toISOString());
      
      // Also record in trial tracking
      await db.run(`
        INSERT INTO trial_tracking (phone, trial_start_date, trial_end_date, trial_status)
        VALUES (?, ?, ?, 'active')
      `, userPhone, now.toISOString(), trialEndDate.toISOString());
      
      console.log(`✅ Subscriber permanently recorded: ${userPhone} - ${user.business_name}`);
    } else {
      // Update existing subscriber
      await db.run(`
        UPDATE subscribers SET 
          business_name = ?, business_type = ?, location = ?,
          trial_start_date = ?, trial_end_date = ?, updated_at = ?
        WHERE phone = ?
      `, user.business_name, user.business_type, incomingMsg, 
         now.toISOString(), trialEndDate.toISOString(), now.toISOString(), userPhone);
      console.log(`✅ Subscriber updated: ${userPhone}`);
    }
    
    const welcomeMsg = `✅ *Registration Complete!* ✅

🎉 Welcome to DukaApp, ${user.business_name}!

Business: ${user.business_type}
Location: ${user.location}

━━━━━━━━━━━━━━━━━━━━
*📚 HOW TO USE DUKAAPP*
━━━━━━━━━━━━━━━━━━━━

💰 *SALE 1000* - Record a sale
💸 *EXPENSE 500* - Record an expense
💵 *CASH 1000* - Record a cash sale
📊 *PROFIT* - View your profit
📋 *STATUS* - Check your info

📦 *STOCK MANAGEMENT*
• stock [product] - Check stock
• addstock [product] [qty] - Add stock
• usestock [product] [qty] - Use stock
• liststock - View all products
• lowstock - Low stock alerts

💳 *SUBSCRIPTION*
You have a *14-day free trial*!
After trial: KES 299/month
Reply *PAY NOW* to subscribe early

🤖 *AUTO-RECORDING*
Just forward your M-Pesa messages!
• Received money → Auto-sale
• Sent money → Auto-expense

Type *HELP* anytime to see all commands.

Thank you for choosing DukaApp! 🚀`;
    
    twiml.message(welcomeMsg);
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // START COMMAND - Begin registration
  if (incomingMsg === 'start') {
    await updateUser(userPhone, { step: 'waiting_for_business_name' });
    twiml.message(`🎉 *Welcome to DukaApp!* 🎉\n\nLet's get your business registered.\n\n*Step 1 of 3:* What is your business name?\n\nType your business name (e.g., "Katungu General Store")`);
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // DEFAULT RESPONSE FOR UNREGISTERED USERS
  twiml.message(`👋 *Welcome to DukaApp!* 👋\n\nTrack sales, expenses, and profit on WhatsApp.\n\nTo begin your 14-day free trial, reply: *START*\n\nWe'll ask for your business name, type, and location.\n\nQuestions? Reply: SUPPORT`);
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ DukaApp server running on port ${PORT}`);
  console.log(`✅ Health check: /health`);
  console.log(`✅ WhatsApp webhook: /whatsapp`);
  console.log(`✅ Admin dashboard: /admin-dashboard (Password: Dallas123!)`);
  console.log(`✅ Subscriber tracking enabled - PERMANENT REGISTRATION`);
  console.log(`✅ M-Pesa STK Push enabled`);
  console.log(`✅ Stock management enabled`);
});
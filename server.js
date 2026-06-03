// server.js - DukaApp with PostgreSQL for Permanent User Registration
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
const app = express();

// ============================================================
// POSTGRESQL DATABASE CONNECTION
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Render PostgreSQL
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

// Initialize all tables
async function initDatabase() {
  const client = await pool.connect();
  try {
    // Users table - primary table for all users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        business_name TEXT,
        business_type TEXT,
        location TEXT,
        registered INTEGER DEFAULT 0,
        step TEXT DEFAULT 'none',
        trial_start_date TIMESTAMP,
        trial_end_date TIMESTAMP,
        subscription_status TEXT DEFAULT 'trial',
        subscription_end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Transactions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        phone TEXT,
        amount REAL,
        type TEXT,
        category TEXT,
        description TEXT,
        date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Payments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        phone TEXT,
        amount REAL,
        checkout_request_id TEXT,
        mpesa_receipt TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Stock products table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_products (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        product_name TEXT NOT NULL,
        quantity REAL DEFAULT 0,
        unit TEXT DEFAULT 'pcs',
        reorder_level REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, product_name)
      )
    `);
    
    // Stock transactions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_transactions (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        product_id INTEGER,
        transaction_type TEXT CHECK(transaction_type IN ('add', 'use', 'adjust')),
        quantity REAL NOT NULL,
        reason TEXT,
        previous_quantity REAL,
        new_quantity REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Subscribers table - comprehensive tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        business_name TEXT,
        business_type TEXT,
        location TEXT,
        subscription_status TEXT DEFAULT 'trial',
        status_history TEXT,
        trial_start_date TIMESTAMP,
        trial_end_date TIMESTAMP,
        subscription_start_date TIMESTAMP,
        subscription_end_date TIMESTAMP,
        last_payment_date TIMESTAMP,
        last_payment_amount REAL,
        total_paid REAL DEFAULT 0,
        cancelled_date TIMESTAMP,
        cancellation_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Payment history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_history (
        id SERIAL PRIMARY KEY,
        subscriber_id INTEGER,
        phone TEXT,
        amount REAL,
        payment_method TEXT DEFAULT 'mpesa_stk',
        mpesa_receipt TEXT,
        checkout_request_id TEXT,
        status TEXT DEFAULT 'pending',
        payment_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Business metrics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_metrics (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        metric_date DATE DEFAULT CURRENT_DATE,
        daily_sales REAL DEFAULT 0,
        daily_expenses REAL DEFAULT 0,
        daily_profit REAL DEFAULT 0,
        weekly_sales REAL DEFAULT 0,
        weekly_profit REAL DEFAULT 0,
        monthly_sales REAL DEFAULT 0,
        monthly_profit REAL DEFAULT 0,
        average_transaction REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Loan applications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS loan_applications (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        business_name TEXT,
        business_type TEXT,
        business_location TEXT,
        loan_amount REAL,
        loan_purpose TEXT,
        requested_terms TEXT,
        status TEXT DEFAULT 'pending',
        credit_score INTEGER,
        eligibility TEXT,
        lender TEXT,
        application_date TIMESTAMP,
        reviewed_date TIMESTAMP,
        reviewed_by TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Customer consent table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_consent (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        consent_type TEXT,
        consent_given INTEGER DEFAULT 0,
        consent_date TIMESTAMP,
        shared_with TEXT,
        purpose TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ PostgreSQL tables ready');
  } catch (error) {
    console.error('Database init error:', error);
  } finally {
    client.release();
  }
}

initDatabase();

// ============================================================
// M-PESA DARAJA API CONFIGURATION
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
// POSTGRESQL USER MANAGEMENT FUNCTIONS (PERMANENT)
// ============================================================

async function getUser(phone) {
  const client = await pool.connect();
  try {
    let result = await client.query('SELECT * FROM users WHERE phone = $1', [phone]);
    
    if (result.rows.length === 0) {
      const now = new Date();
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 14);
      
      await client.query(`
        INSERT INTO users (phone, step, trial_start_date, trial_end_date, subscription_status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [phone, 'none', now.toISOString(), trialEndDate.toISOString(), 'trial', now.toISOString()]);
      
      result = await client.query('SELECT * FROM users WHERE phone = $1', [phone]);
      console.log(`🆕 Created new user: ${phone}`);
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function updateUser(phone, updates) {
  const client = await pool.connect();
  try {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    await client.query(`UPDATE users SET ${setClause} WHERE phone = $${fields.length + 1}`, [...values, phone]);
    console.log(`📝 Updated user ${phone}:`, updates);
  } finally {
    client.release();
  }
}

async function getSubscriptionStatus(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT subscription_status, trial_end_date, subscription_end_date FROM users WHERE phone = $1',
      [phone]
    );
    
    if (result.rows.length === 0) return { status: 'no_account' };
    
    const user = result.rows[0];
    
    if (user.subscription_status === 'trial' && user.trial_end_date) {
      const daysLeft = Math.ceil((new Date(user.trial_end_date) - new Date()) / (1000 * 60 * 60 * 24));
      return { status: 'trial', daysLeft: Math.max(0, daysLeft), endDate: user.trial_end_date };
    }
    if (user.subscription_status === 'active' && user.subscription_end_date) {
      const daysLeft = Math.ceil((new Date(user.subscription_end_date) - new Date()) / (1000 * 60 * 60 * 24));
      return { status: 'active', daysLeft: Math.max(0, daysLeft), endDate: user.subscription_end_date };
    }
    return { status: user.subscription_status || 'unknown' };
  } finally {
    client.release();
  }
}

async function recordNewSubscriber(phone, businessName, businessType, location) {
  const client = await pool.connect();
  try {
    const now = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);
    
    await client.query(`
      UPDATE users SET 
        business_name = $1, business_type = $2, location = $3, 
        registered = 1, trial_start_date = $4, trial_end_date = $5
      WHERE phone = $6
    `, [businessName, businessType, location, now.toISOString(), trialEndDate.toISOString(), phone]);
    
    const existing = await client.query('SELECT * FROM subscribers WHERE phone = $1', [phone]);
    
    if (existing.rows.length === 0) {
      await client.query(`
        INSERT INTO subscribers (
          phone, business_name, business_type, location, 
          subscription_status, trial_start_date, trial_end_date,
          status_history, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'trial', $5, $6, $7, $8, $9)
      `, [phone, businessName, businessType, location, now.toISOString(), trialEndDate.toISOString(),
          JSON.stringify([{ status: 'trial', date: now.toISOString(), note: 'User registered' }]),
          now.toISOString(), now.toISOString()]);
      
      console.log(`📊 New subscriber permanently recorded: ${phone} - ${businessName}`);
    }
  } finally {
    client.release();
  }
}

// ============================================================
// M-PESA HELPER FUNCTIONS
// ============================================================

async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  try {
    const response = await axios.get(`${MPESA_API_BASE}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } });
    console.log('✅ M-Pesa access token obtained');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Error getting M-Pesa token:', error.response?.data || error.message);
    return null;
  }
}

function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
}

function formatPhoneForMpesa(phoneNumber) {
  let phone = phoneNumber.replace('whatsapp:', '').replace(/\+/g, '').replace(/\D/g, '');
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
    const response = await axios.post(`${MPESA_API_BASE}/mpesa/stkpush/v1/processrequest`, data,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
    
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

function isMpesaMessage(message) {
  const mpesaKeywords = [/confirmed/i, /received/i, /sent to/i, /paid to/i, /mpesa/i, /kcb/i, /UEU/i, /UESIR/i, /UEVIR/i];
  return mpesaKeywords.some(pattern => pattern.test(message));
}

function parseMpesaMessage(message) {
  let amount = null;
  let isReceived = false;
  let sender = null;
  let receiver = null;
  
  const receivedPattern = /(?:You have received|Received)\s+Ksh([\d,]+(?:\.\d{2})?)\s+from\s+(.+?)(?:\s+on|$)/i;
  const sentPattern = /Ksh([\d,]+(?:\.\d{2})?)\s+(?:sent|paid) to\s+(.+?)(?:\s+on|$)/i;
  
  let match = message.match(receivedPattern);
  if (match) {
    amount = parseFloat(match[1].replace(/,/g, ''));
    isReceived = true;
    sender = match[2] || 'Unknown';
  } else {
    match = message.match(sentPattern);
    if (match) {
      amount = parseFloat(match[1].replace(/,/g, ''));
      isReceived = false;
      receiver = match[2] || 'Unknown';
    }
  }
  
  return { amount, isReceived, sender, receiver };
}

async function recordMpesaTransaction(phone, amount, type, description) {
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    await client.query(`
      INSERT INTO transactions (phone, amount, type, description, date, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [phone, amount, type, `M-Pesa: ${description}`, today, new Date().toISOString()]);
    console.log(`📱 Auto-recorded ${type} for ${phone}: KES ${amount}`);
  } finally {
    client.release();
  }
}

async function recordSale(phone, amount) {
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    await client.query(`
      INSERT INTO transactions (phone, amount, type, description, date, created_at)
      VALUES ($1, $2, 'sale', $3, $4, $5)
    `, [phone, amount, `Manual sale: KES ${amount}`, today, new Date().toISOString()]);
    console.log(`💰 Sale recorded for ${phone}: KES ${amount}`);
  } finally {
    client.release();
  }
}

async function recordExpense(phone, amount, category) {
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    await client.query(`
      INSERT INTO transactions (phone, amount, type, category, description, date, created_at)
      VALUES ($1, $2, 'expense', $3, $4, $5, $6)
    `, [phone, amount, category, `Manual expense: KES ${amount} (${category})`, today, new Date().toISOString()]);
    console.log(`💸 Expense recorded for ${phone}: KES ${amount} (${category})`);
  } finally {
    client.release();
  }
}

async function recordCashSale(phone, amount) {
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    await client.query(`
      INSERT INTO transactions (phone, amount, type, description, date, created_at)
      VALUES ($1, $2, 'cash_sale', $3, $4, $5)
    `, [phone, amount, `Cash sale: KES ${amount}`, today, new Date().toISOString()]);
    console.log(`💵 Cash sale recorded for ${phone}: KES ${amount}`);
  } finally {
    client.release();
  }
}

// ============================================================
// CREDIT SCORING FUNCTIONS
// ============================================================

async function calculateCreditScore(phone) {
  const client = await pool.connect();
  try {
    const user = await client.query('SELECT created_at FROM users WHERE phone = $1', [phone]);
    let score = 0;
    
    if (user.rows.length > 0) {
      const daysActive = Math.ceil((new Date() - new Date(user.rows[0].created_at)) / (1000 * 60 * 60 * 24));
      score += Math.min(30, Math.floor(daysActive / 3));
    }
    
    const transactions = await client.query(`
      SELECT COUNT(*) as total FROM transactions WHERE phone = $1 AND type IN ('sale', 'cash_sale') AND date >= date('now', '-90 days')
    `, [phone]);
    score += Math.min(25, Math.floor((transactions.rows[0]?.total || 0) / 4));
    
    return Math.min(100, score);
  } finally {
    client.release();
  }
}

async function calculateLoanEligibility(phone) {
  const creditScore = await calculateCreditScore(phone);
  let eligibleAmount = 0, interestRate = 0, repaymentMonths = 0;
  
  if (creditScore >= 80) {
    eligibleAmount = 100000;
    interestRate = 8;
    repaymentMonths = 6;
  } else if (creditScore >= 60) {
    eligibleAmount = 50000;
    interestRate = 10;
    repaymentMonths = 4;
  } else if (creditScore >= 40) {
    eligibleAmount = 20000;
    interestRate = 12;
    repaymentMonths = 3;
  } else if (creditScore >= 20) {
    eligibleAmount = 5000;
    interestRate = 13;
    repaymentMonths = 2;
  } else {
    eligibleAmount = 0;
    interestRate = 15;
    repaymentMonths = 2;
  }
  
  return {
    creditScore, eligibleAmount, interestRate, repaymentMonths,
    recommendation: creditScore >= 50 ? 'Eligible' : 'Building Credit'
  };
}

// ============================================================
// STOCK MANAGEMENT FUNCTIONS
// ============================================================

async function addStock(phone, productName, quantity) {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT * FROM stock_products WHERE phone = $1 AND product_name = $2', [phone, productName]);
    
    if (existing.rows.length > 0) {
      const newQuantity = existing.rows[0].quantity + quantity;
      await client.query('UPDATE stock_products SET quantity = $1, updated_at = NOW() WHERE phone = $2 AND product_name = $3', 
        [newQuantity, phone, productName]);
      return { success: true, product: productName, oldQty: existing.rows[0].quantity, newQty: newQuantity };
    } else {
      await client.query('INSERT INTO stock_products (phone, product_name, quantity) VALUES ($1, $2, $3)', 
        [phone, productName, quantity]);
      return { success: true, product: productName, newQty: quantity, isNew: true };
    }
  } finally {
    client.release();
  }
}

async function useStock(phone, productName, quantity) {
  const client = await pool.connect();
  try {
    const product = await client.query('SELECT * FROM stock_products WHERE phone = $1 AND product_name = $2', [phone, productName]);
    
    if (product.rows.length === 0) {
      return { success: false, error: `Product "${productName}" not found` };
    }
    
    if (product.rows[0].quantity < quantity) {
      return { success: false, error: `Insufficient stock. Available: ${product.rows[0].quantity}` };
    }
    
    const newQuantity = product.rows[0].quantity - quantity;
    await client.query('UPDATE stock_products SET quantity = $1, updated_at = NOW() WHERE phone = $2 AND product_name = $3', 
      [newQuantity, phone, productName]);
    
    return { success: true, product: productName, usedQty: quantity, remainingQty: newQuantity };
  } finally {
    client.release();
  }
}

async function listStock(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT product_name, quantity, unit FROM stock_products WHERE phone = $1 ORDER BY product_name', [phone]);
    return result.rows;
  } finally {
    client.release();
  }
}

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

// ============================================================
// ADMIN DASHBOARD PAGE
// ============================================================

app.get('/admin-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/start-trial', (req, res) => {
  res.redirect('https://wa.me/14155238886?text=start');
});

app.get('/agent-signup', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Become a DukaApp Agent</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;margin:0;}.card{background:white;border-radius:30px;padding:40px;max-width:500px;width:100%;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);}h1{color:#333;}.commission{background:#f0fdf4;border-radius:20px;padding:20px;margin:20px 0;}.commission h3{color:#28a745;font-size:28px;margin:0;}.btn{background:#25D366;color:white;padding:15px 30px;border-radius:50px;text-decoration:none;display:inline-block;font-weight:600;margin-top:20px;}</style></head><body><div class="card"><h1>🚀 Become a DukaApp Agent</h1><p class="subtitle">Earn KES 200 per shop + 10% monthly recurring commission</p><div class="commission"><h3>KES 200</h3><p>per shop signup bonus</p><p style="font-size:14px;">+ 10% of subscription (KES 30/month for 3 months)</p></div><p>To become an agent, send "agent" to our WhatsApp number.</p><a href="https://wa.me/14155238886?text=agent" class="btn">Start on WhatsApp →</a></div></body></html>`);
});

// ============================================================
// MPESA CALLBACK ENDPOINT
// ============================================================

app.post('/mpesa-callback', async (req, res) => {
  console.log('📞 M-Pesa callback received');
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ============================================================
// WHATSAPP WEBHOOK - MAIN HANDLER WITH PERMANENT REGISTRATION
// ============================================================

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.trim() : '';
  const incomingMsgLower = incomingMsg.toLowerCase();
  const userPhone = req.body.From || 'unknown';
  
  console.log(`📩 Message from ${userPhone}: "${incomingMsg.substring(0, 100)}"`);
  
  // Get user from PostgreSQL (PERMANENT)
  let user = await getUser(userPhone);
  const subscription = await getSubscriptionStatus(userPhone);
  
  console.log(`🔍 User status: registered=${user.registered}, step=${user.step}, name=${user.business_name || 'none'}`);
  
  // M-PESA AUTO-DETECTION
  if (isMpesaMessage(incomingMsg) && user.registered === 1) {
    const parsed = parseMpesaMessage(incomingMsg);
    if (parsed.amount && parsed.amount > 0) {
      if (parsed.isReceived) {
        await recordMpesaTransaction(userPhone, parsed.amount, 'sale', `Received from ${parsed.sender || 'customer'}`);
        twiml.message(`✅ *M-Pesa Sale Auto-Recorded!*\n\n💰 Amount: KES ${parsed.amount.toFixed(2)}\n📊 From: ${parsed.sender || 'Customer'}\n\nType *PROFIT* for full report.`);
      } else {
        await recordMpesaTransaction(userPhone, parsed.amount, 'expense', `Paid to ${parsed.receiver || 'supplier'}`);
        twiml.message(`✅ *M-Pesa Expense Auto-Recorded!*\n\n💸 Amount: KES ${parsed.amount.toFixed(2)}\n📊 Paid to: ${parsed.receiver || 'Vendor'}\n\nType *PROFIT* for full report.`);
      }
      res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
    }
  }
  
  // PAY NOW COMMAND
  if (incomingMsgLower === 'pay now' || incomingMsgLower === 'pay') {
    twiml.message(`💰 *Processing Payment*\n\nPlease wait while we initiate your M-Pesa STK Push.\n\n💳 Amount: KES 299\n🏪 Service: DukaApp Subscription\n\nYou will receive a popup on your phone shortly.`);
    
    const result = await initiateSTKPush(userPhone, 299, `DukaApp_${userPhone.slice(-8)}`, 'DukaApp Subscription');
    if (result.success) {
      const client = await pool.connect();
      try {
        await client.query(`INSERT INTO payments (phone, amount, checkout_request_id, status) VALUES ($1, $2, $3, 'pending')`, 
          [userPhone, 299, result.checkoutRequestId]);
        pendingPayments[result.checkoutRequestId] = { phone: userPhone, amount: 299 };
      } finally {
        client.release();
      }
    }
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // ============================================================
  // REGISTERED USER COMMANDS (PERMANENT - NEVER ASKS TO REGISTER AGAIN)
  // ============================================================
  
  if (user.registered === 1) {
    console.log(`✅ User IS registered: ${user.business_name}`);
    
    // LOAN CHECK COMMAND
    if (incomingMsgLower.startsWith('loan check')) {
      const eligibility = await calculateLoanEligibility(userPhone);
      const userRecord = await pool.connect();
      let daysActive = 0;
      try {
        const result = await userRecord.query('SELECT created_at FROM users WHERE phone = $1', [userPhone]);
        if (result.rows.length > 0) {
          daysActive = Math.ceil((new Date() - new Date(result.rows[0].created_at)) / (1000 * 60 * 60 * 24));
        }
      } finally {
        userRecord.release();
      }
      
      let buildCreditMessage = '';
      if (eligibility.creditScore < 20) {
        buildCreditMessage = `📈 *How to Build Your Credit Score*\n\nYou currently have ${eligibility.creditScore}/100.\n\n✅ Track your sales daily\n✅ Track your expenses\n✅ Forward M-Pesa messages\n✅ Be consistent for 30-90 days\n\n*The longer you use DukaApp, the higher your credit score!*\n\n📅 Days active: ${daysActive}\n🎯 Target: 30+ days for loans`;
      } else {
        buildCreditMessage = `🎉 *Great progress!*\n\nCredit Score: ${eligibility.creditScore}/100\n✅ Keep tracking to increase your limit`;
      }
      
      twiml.message(`🏦 *Your Credit Score & Loan Eligibility*\n\n━━━━━━━━━━━━━━━━━━━━\n📊 Credit Score: ${eligibility.creditScore}/100\n━━━━━━━━━━━━━━━━━━━━\n\n💰 Estimated Loan Amount: KES ${eligibility.eligibleAmount.toLocaleString()}\n📉 Interest Rate: ${eligibility.interestRate}% flat\n📅 Repayment Period: ${eligibility.repaymentMonths} months\n\n━━━━━━━━━━━━━━━━━━━━\n${buildCreditMessage}\n━━━━━━━━━━━━━━━━━━━━\n\nTo apply for a loan, reply: *LOAN APPLY*`);
    }
    // LOAN APPLY COMMAND
    else if (incomingMsgLower.startsWith('loan apply')) {
      const eligibility = await calculateLoanEligibility(userPhone);
      if (eligibility.creditScore < 50) {
        twiml.message(`❌ *Loan Application Not Approved*\n\nYour credit score (${eligibility.creditScore}/100) is below our minimum requirement.\n\n*How to improve:*\n• Record all your sales daily\n• Use DukaApp consistently for 30+ days\n\nKeep using DukaApp and check again in 2 weeks!`);
      } else {
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO loan_applications (phone, business_name, business_type, business_location, loan_amount, status, credit_score, eligibility, application_date)
            VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
          `, [userPhone, user.business_name, user.business_type, user.location, eligibility.eligibleAmount, eligibility.creditScore, eligibility.recommendation, new Date().toISOString()]);
          twiml.message(`✅ *Loan Application Submitted!*\n\n📊 Credit Score: ${eligibility.creditScore}/100\n💰 Requested Amount: KES ${eligibility.eligibleAmount.toLocaleString()}\n\n⏰ We will contact you within 24-48 hours with loan offers.\n\nReply *CONSENT YES* to share your data with lenders.`);
        } finally {
          client.release();
        }
      }
    }
    // CONSENT YES COMMAND
    else if (incomingMsgLower.startsWith('consent yes')) {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO customer_consent (phone, consent_type, consent_given, consent_date, purpose)
          VALUES ($1, 'data_sharing', 1, $2, 'Loan application processing')
        `, [userPhone, new Date().toISOString()]);
        twiml.message(`✅ *Thank you for your consent!*\n\nYour business data will now be shared with partner lenders.\n\nWe will contact you with loan offers within 24 hours.\n\nType *LOAN STATUS* to check your application status.`);
      } finally {
        client.release();
      }
    }
    // LOAN STATUS COMMAND
    else if (incomingMsgLower.startsWith('loan status')) {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT * FROM loan_applications WHERE phone = $1 ORDER BY application_date DESC LIMIT 1
        `, [userPhone]);
        
        if (result.rows.length === 0) {
          twiml.message(`📋 *No loan application found*\n\nTo apply, type: *LOAN APPLY*`);
        } else {
          const app = result.rows[0];
          twiml.message(`🏦 *Loan Application Status*\n\n━━━━━━━━━━━━━━━━━━━━\n📅 Date: ${new Date(app.application_date).toLocaleDateString()}\n💰 Amount: KES ${app.loan_amount.toLocaleString()}\n📊 Credit Score: ${app.credit_score}/100\n📈 Status: ${app.status.toUpperCase()}\n━━━━━━━━━━━━━━━━━━━━\n\nWe will contact you within 24 hours.`);
        }
      } finally {
        client.release();
      }
    }
    // HELP COMMAND
    else if (incomingMsgLower === 'help') {
      twiml.message(`📖 *DUKAAPP COMMANDS*\n\n━━━━━━━━━━━━━━━━━━━━\n💰 *Sales & Expenses*\n━━━━━━━━━━━━━━━━━━━━\n• sale [amount]\n• expense [amount] [category]\n• cash [amount]\n\n📦 *Stock Management*\n━━━━━━━━━━━━━━━━━━━━\n• stock [product]\n• addstock [product] [qty]\n• usestock [product] [qty]\n• liststock\n• lowstock\n\n📊 *Reports*\n━━━━━━━━━━━━━━━━━━━━\n• profit - Today's profit\n• status - Business info\n\n💳 *Subscription*\n━━━━━━━━━━━━━━━━━━━━\n• pay now - KES 299/month\n\n🏦 *Loans & Credit*\n━━━━━━━━━━━━━━━━━━━━\n• loan check - Credit score\n• loan apply - Apply for loan\n• loan status - Check application\n• consent yes - Share data\n\n🤖 *M-Pesa Auto-Record*\nJust forward M-Pesa messages!\n\nExamples: sale 1500, addstock sugar 50, profit, pay now`);
    }
    // STATUS COMMAND
    else if (incomingMsgLower === 'status') {
      const stock = await listStock(userPhone);
      twiml.message(`📋 *BUSINESS STATUS*\n\n🏪 Business: ${user.business_name}\n📂 Type: ${user.business_type}\n📍 Location: ${user.location}\n\n📦 Products in stock: ${stock.length}\n\nType *help* for all commands.`);
    }
    // PROFIT COMMAND
    else if (incomingMsgLower === 'profit') {
      const client = await pool.connect();
      try {
        const today = new Date().toISOString().split('T')[0];
        const sales = await client.query(`SELECT SUM(amount) as total FROM transactions WHERE phone = $1 AND type IN ('sale', 'cash_sale') AND date = $2`, [userPhone, today]);
        const expenses = await client.query(`SELECT SUM(amount) as total FROM transactions WHERE phone = $1 AND type = 'expense' AND date = $2`, [userPhone, today]);
        const totalSales = sales.rows[0]?.total || 0;
        const totalExpenses = expenses.rows[0]?.total || 0;
        const profit = totalSales - totalExpenses;
        twiml.message(`📊 *TODAY'S PROFIT*\n\n💰 Sales: KES ${totalSales}\n💸 Expenses: KES ${totalExpenses}\n━━━━━━━━━━━━━━━━━━━━\n📈 PROFIT: KES ${profit}`);
      } finally {
        client.release();
      }
    }
    // STOCK COMMANDS
    else if (incomingMsgLower.startsWith('addstock')) {
      const parts = incomingMsgLower.split(' ');
      if (parts.length < 3) {
        twiml.message(`📦 *Add Stock*\n\nType: addstock [product] [quantity]\nExample: addstock sugar 50`);
      } else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        if (isNaN(quantity) || quantity <= 0) {
          twiml.message(`❌ Invalid quantity. Enter a valid number.`);
        } else {
          const result = await addStock(userPhone, productName, quantity);
          if (result.success) {
            twiml.message(`✅ ${result.isNew ? 'New product added!' : 'Stock updated!'}\n\n📦 ${productName}: ${result.isNew ? result.newQty : `${result.oldQty} → ${result.newQty}`} units`);
          }
        }
      }
    }
    else if (incomingMsgLower.startsWith('usestock')) {
      const parts = incomingMsgLower.split(' ');
      if (parts.length < 3) {
        twiml.message(`📦 *Use Stock*\n\nType: usestock [product] [quantity]\nExample: usestock sugar 5`);
      } else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        if (isNaN(quantity) || quantity <= 0) {
          twiml.message(`❌ Invalid quantity.`);
        } else {
          const result = await useStock(userPhone, productName, quantity);
          if (result.success) {
            twiml.message(`✅ *Stock used!*\n\n📦 ${result.product}: Used ${result.usedQty} units\n📊 Remaining: ${result.remainingQty} units`);
          } else {
            twiml.message(`❌ ${result.error}`);
          }
        }
      }
    }
    else if (incomingMsgLower === 'liststock') {
      const products = await listStock(userPhone);
      if (products.length === 0) {
        twiml.message(`📦 *No products in inventory*\n\nAdd products with: addstock [product] [quantity]`);
      } else {
        let stockList = `📦 *COMPLETE INVENTORY*\n\n`;
        for (const p of products) {
          stockList += `• *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
        }
        stockList += `\nTotal: ${products.length} products`;
        twiml.message(stockList);
      }
    }
    else if (incomingMsgLower === 'lowstock') {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT product_name, quantity, unit, reorder_level 
          FROM stock_products WHERE phone = $1 AND quantity <= reorder_level ORDER BY quantity ASC
        `, [userPhone]);
        
        if (result.rows.length === 0) {
          twiml.message(`✅ *No low stock items*\n\nAll products are well stocked.`);
        } else {
          let alertMsg = `⚠️ *LOW STOCK ALERT*\n\n`;
          for (const p of result.rows) {
            alertMsg += `📦 ${p.product_name}: ${p.quantity} ${p.unit} left\n`;
          }
          alertMsg += `\nRestock with: addstock [product] [quantity]`;
          twiml.message(alertMsg);
        }
      } finally {
        client.release();
      }
    }
    else if (incomingMsgLower.startsWith('sale')) {
      const amount = incomingMsgLower.split(' ')[1];
      if (amount && !isNaN(amount)) {
        await recordSale(userPhone, parseFloat(amount));
        twiml.message(`✅ *Sale Recorded!* KES ${amount}`);
      } else {
        twiml.message(`📊 *Record a Sale*\n\nType: sale [amount]\nExample: sale 1500`);
      }
    }
    else if (incomingMsgLower.startsWith('expense')) {
      const parts = incomingMsgLower.split(' ');
      const amount = parts[1];
      const category = parts[2] || 'general';
      if (amount && !isNaN(amount)) {
        await recordExpense(userPhone, parseFloat(amount), category);
        twiml.message(`✅ *Expense Recorded!* KES ${amount} (${category})`);
      } else {
        twiml.message(`💸 *Record an Expense*\n\nType: expense [amount] [category]\nExample: expense 500 rent`);
      }
    }
    else if (incomingMsgLower.startsWith('cash')) {
      const amount = incomingMsgLower.split(' ')[1];
      if (amount && !isNaN(amount)) {
        await recordCashSale(userPhone, parseFloat(amount));
        twiml.message(`✅ *Cash Sale Recorded!* KES ${amount}`);
      } else {
        twiml.message(`💵 *Record a Cash Sale*\n\nType: cash [amount]\nExample: cash 1000`);
      }
    }
    else if (incomingMsgLower === 'agent') {
      twiml.message(`🤝 *Become a DukaApp Agent*\n\n• KES 200 per shop you sign up\n• 10% recurring commission\n\nSign up: https://dukaapp.online/agent-signup`);
    }
    else {
      twiml.message(`❌ Command not recognized.\n\nType *help* to see all commands.\n\nExamples:\n• sale 1500\n• addstock sugar 50\n• profit\n• loan check`);
    }
    
    res.set('Content-Type', 'text/xml'); res.send(twiml.toString()); return;
  }
  
  // ============================================================
  // REGISTRATION FLOW (Only for NEW users)
  // ============================================================
  
  if (user.step === 'waiting_for_business_name') {
    await updateUser(userPhone, { business_name: incomingMsg, step: 'waiting_for_business_type' });
    twiml.message(`Great! What type of business do you run?\n\nExamples: Retail Shop, Grocery, Hardware, Restaurant, Salon, Boutique, etc.\n\nType your business type.`);
  }
  else if (user.step === 'waiting_for_business_type') {
    await updateUser(userPhone, { business_type: incomingMsg, step: 'waiting_for_location' });
    twiml.message(`Where is your business located?\n\nExamples: Nairobi, Mombasa, Kisumu, Nakuru, etc.\n\nType your location.`);
  }
  else if (user.step === 'waiting_for_location') {
    await updateUser(userPhone, { location: incomingMsg, registered: 1, step: 'none' });
    await recordNewSubscriber(userPhone, user.business_name, user.business_type, incomingMsg);
    
    twiml.message(`✅ *Registration Complete!* ✅\n\n🎉 Welcome to DukaApp, ${user.business_name}!\n\nBusiness: ${user.business_type}\nLocation: ${user.location}\n\n━━━━━━━━━━━━━━━━━━━━\n*QUICK START GUIDE*\n━━━━━━━━━━━━━━━━━━━━\n\n💰 *SALE 1000* - Record a sale\n💸 *EXPENSE 500* - Record an expense\n💵 *CASH 1000* - Record a cash sale\n📊 *PROFIT* - View your profit\n📋 *STATUS* - Check your info\n\n📦 *Stock Management*\n• addstock sugar 50 - Add stock\n• usestock sugar 5 - Use stock\n• liststock - View all\n\n💳 *Subscription*\nYou have a *14-day free trial*!\nAfter trial: KES 299/month\nReply *PAY NOW* to subscribe early\n\n🏦 *Loans*\nType *LOAN CHECK* to see your credit score!\n\n🤖 *M-Pesa Auto-Record*\nJust forward your M-Pesa messages!\n\nType *HELP* for all commands.\n\nThank you for choosing DukaApp! 🚀`);
  }
  else if (incomingMsgLower === 'start') {
    await updateUser(userPhone, { step: 'waiting_for_business_name' });
    twiml.message(`🎉 *Welcome to DukaApp!* 🎉\n\nLet's get your business registered.\n\n*Step 1 of 3:* What is your business name?\n\nType your business name (e.g., "Katungu General Store")`);
  }
  else {
    twiml.message(`👋 *Welcome to DukaApp!* 👋\n\nTrack sales, expenses, and profit on WhatsApp.\n\nTo begin your 14-day free trial, reply: *START*\n\nWe'll ask for your business name, type, and location.\n\nQuestions? Reply: SUPPORT`);
  }
  
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
  console.log(`✅ PostgreSQL database connected - PERMANENT STORAGE`);
  console.log(`✅ Users will NEVER have to register again!`);
});
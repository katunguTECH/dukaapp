// server.js - Complete DukaApp Server with M-Pesa STK Push
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const axios = require('axios');
const crypto = require('crypto');
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

// Store pending payments in memory (for callback matching)
const pendingPayments = {};

// ============================================================
// M-PESA HELPER FUNCTIONS
// ============================================================

async function getMpesaAccessToken() {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  
  try {
    const response = await axios.get(
      `${MPESA_API_BASE}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        }
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
  // Remove whatsapp: prefix if present
  let phone = phoneNumber.replace('whatsapp:', '').replace(/\+/g, '');
  // Remove any non-digit characters
  phone = phone.replace(/\D/g, '');
  
  // Convert to 254 format
  if (phone.startsWith('0')) {
    phone = '254' + phone.substring(1);
  } else if (phone.startsWith('7')) {
    phone = '254' + phone;
  } else if (phone.startsWith('1')) {
    phone = '254' + phone;
  }
  
  return phone;
}

async function initiateSTKPush(phoneNumber, amount, accountReference, transactionDesc) {
  const accessToken = await getMpesaAccessToken();
  if (!accessToken) {
    return { success: false, error: "Failed to get access token" };
  }
  
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
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('STK Push response:', response.data);
    
    if (response.data.ResponseCode === '0') {
      return { 
        success: true, 
        checkoutRequestId: response.data.CheckoutRequestID,
        message: "STK Push sent successfully"
      };
    } else {
      return { 
        success: false, 
        error: response.data.ResponseDescription || "STK Push failed"
      };
    }
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    return { success: false, error: error.message };
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
    
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      amount REAL,
      checkout_request_id TEXT,
      mpesa_receipt TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
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
  `);
  console.log('✅ Database ready');
  
  // Run initial subscription check
  await checkExpiredTrials();
}

initDatabase();

// ============================================================
// SUBSCRIPTION MANAGEMENT FUNCTIONS
// ============================================================

async function checkExpiredTrials() {
  const now = new Date().toISOString();
  const expiredUsers = await db.all(
    `SELECT * FROM users 
     WHERE subscription_status = 'trial' 
     AND trial_end_date <= ?`,
    now
  );
  
  for (const user of expiredUsers) {
    await db.run(
      `UPDATE users SET subscription_status = 'expired' WHERE phone = ?`,
      user.phone
    );
    console.log(`⚠️ Trial expired for ${user.phone}`);
  }
}

async function activateSubscription(phone, paymentAmount, mpesaReceipt, checkoutRequestId) {
  const subscriptionEndDate = new Date();
  subscriptionEndDate.setDate(subscriptionEndDate.getDate() + 30);
  
  await db.run(
    `UPDATE users SET 
      subscription_status = 'active',
      subscription_end_date = ?,
      trial_start_date = NULL,
      trial_end_date = NULL
     WHERE phone = ?`,
    subscriptionEndDate.toISOString(), phone
  );
  
  await db.run(
    `UPDATE payments 
     SET status = 'completed', mpesa_receipt = ? 
     WHERE checkout_request_id = ?`,
    mpesaReceipt, checkoutRequestId
  );
  
  console.log(`✅ Subscription activated for ${phone} until ${subscriptionEndDate.toISOString()}`);
}

async function getSubscriptionStatus(phone) {
  const user = await db.get(
    `SELECT subscription_status, trial_end_date, subscription_end_date 
     FROM users WHERE phone = ?`,
    phone
  );
  
  if (!user) return { status: 'no_account' };
  
  if (user.subscription_status === 'trial' && user.trial_end_date) {
    const daysLeft = Math.ceil((new Date(user.trial_end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { status: 'trial', daysLeft: Math.max(0, daysLeft), endDate: user.trial_end_date };
  }
  
  if (user.subscription_status === 'active' && user.subscription_end_date) {
    const daysLeft = Math.ceil((new Date(user.subscription_end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { status: 'active', daysLeft: Math.max(0, daysLeft), endDate: user.subscription_end_date };
  }
  
  if (user.subscription_status === 'expired') {
    return { status: 'expired' };
  }
  
  return { status: 'unknown' };
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('.'));

// ============================================================
// HEALTH CHECK ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'DukaApp server is running on Render',
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    uptime: process.uptime()
  });
});

app.get('/test', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// ============================================================
// M-PESA CALLBACK ENDPOINT
// ============================================================

app.post('/mpesa-callback', async (req, res) => {
  console.log('📞 M-Pesa callback received');
  
  try {
    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;
    
    if (stkCallback) {
      const checkoutRequestId = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      const resultDesc = stkCallback.ResultDesc;
      
      console.log(`Callback: CheckoutID=${checkoutRequestId}, ResultCode=${resultCode}, ResultDesc=${resultDesc}`);
      
      if (resultCode === 0) {
        // Payment successful
        const mpesaReceipt = stkCallback.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
        const amount = stkCallback.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value;
        
        // Find the payment record
        const payment = await db.get(
          'SELECT * FROM payments WHERE checkout_request_id = ? AND status = "pending"',
          checkoutRequestId
        );
        
        if (payment) {
          await activateSubscription(payment.phone, amount, mpesaReceipt, checkoutRequestId);
          console.log(`✅ Payment confirmed for ${payment.phone}: KES ${amount}, Receipt: ${mpesaReceipt}`);
        } else {
          // Check in-memory pending payments
          if (pendingPayments[checkoutRequestId]) {
            const { phone } = pendingPayments[checkoutRequestId];
            await activateSubscription(phone, amount, mpesaReceipt, checkoutRequestId);
            delete pendingPayments[checkoutRequestId];
            console.log(`✅ Payment confirmed from memory for ${phone}`);
          }
        }
      } else {
        // Payment failed
        console.log(`❌ Payment failed: ${resultDesc}`);
        await db.run(
          `UPDATE payments SET status = 'failed' WHERE checkout_request_id = ?`,
          checkoutRequestId
        );
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

// ============================================================
// STOCK MANAGEMENT FUNCTIONS
// ============================================================

async function getProductStock(phone, productName) {
  const result = await db.get(
    'SELECT * FROM stock_products WHERE phone = ? AND LOWER(product_name) = LOWER(?)',
    phone, productName
  );
  return result;
}

async function addStockProduct(phone, productName, quantity, unit = 'pcs', reorderLevel = 0) {
  const existing = await getProductStock(phone, productName);
  
  if (existing) {
    const newQuantity = existing.quantity + quantity;
    await db.run(
      `UPDATE stock_products 
       SET quantity = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE phone = ? AND LOWER(product_name) = LOWER(?)`,
      newQuantity, phone, productName
    );
    
    await db.run(
      `INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, previous_quantity, new_quantity)
       VALUES (?, ?, 'add', ?, ?, ?)`,
      phone, existing.id, quantity, existing.quantity, newQuantity
    );
    
    return { success: true, product: productName, oldQty: existing.quantity, newQty: newQuantity };
  } else {
    const result = await db.run(
      `INSERT INTO stock_products (phone, product_name, quantity, unit, reorder_level) 
       VALUES (?, ?, ?, ?, ?)`,
      phone, productName, quantity, unit, reorderLevel
    );
    
    await db.run(
      `INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, previous_quantity, new_quantity)
       VALUES (?, ?, 'add', ?, 0, ?)`,
      phone, result.lastID, quantity, quantity
    );
    
    return { success: true, product: productName, newQty: quantity, isNew: true };
  }
}

async function useStockProduct(phone, productName, quantity, reason = 'sale') {
  const product = await getProductStock(phone, productName);
  
  if (!product) {
    return { success: false, error: `Product "${productName}" not found in inventory` };
  }
  
  if (product.quantity < quantity) {
    return { 
      success: false, 
      error: `Insufficient stock. Available: ${product.quantity} ${product.unit}` 
    };
  }
  
  const newQuantity = product.quantity - quantity;
  await db.run(
    `UPDATE stock_products SET quantity = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE phone = ? AND LOWER(product_name) = LOWER(?)`,
    newQuantity, phone, productName
  );
  
  await db.run(
    `INSERT INTO stock_transactions (phone, product_id, transaction_type, quantity, reason, previous_quantity, new_quantity)
     VALUES (?, ?, 'use', ?, ?, ?, ?)`,
    phone, product.id, quantity, reason, product.quantity, newQuantity
  );
  
  return { 
    success: true, 
    product: productName, 
    usedQty: quantity, 
    remainingQty: newQuantity,
    unit: product.unit
  };
}

async function listStockProducts(phone) {
  return await db.all(
    'SELECT product_name, quantity, unit, reorder_level FROM stock_products WHERE phone = ? ORDER BY product_name',
    phone
  );
}

async function getLowStockProducts(phone) {
  return await db.all(
    'SELECT product_name, quantity, unit, reorder_level FROM stock_products WHERE phone = ? AND quantity <= reorder_level ORDER BY quantity ASC',
    phone
  );
}

// ============================================================
// USER MANAGEMENT FUNCTIONS
// ============================================================

async function getUser(phone) {
  let user = await db.get('SELECT * FROM users WHERE phone = ?', phone);
  
  if (!user) {
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);
    
    await db.run(
      `INSERT INTO users (phone, step, trial_start_date, trial_end_date, subscription_status) 
       VALUES (?, ?, ?, ?, 'trial')`,
      phone, 'none', new Date().toISOString(), trialEndDate.toISOString()
    );
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
  console.log(`📝 Updated user ${phone}:`, updates);
}

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const userPhone = req.body.From || 'unknown';
  
  console.log(`📩 Message from ${userPhone}: "${incomingMsg}"`);
  
  // Get user from database
  let user = await getUser(userPhone);
  
  // Check subscription status
  const subscription = await getSubscriptionStatus(userPhone);
  
  // If subscription is expired, restrict commands (except PAY NOW)
  if (subscription.status === 'expired' && !['pay now', 'pay', 'start'].includes(incomingMsg)) {
    twiml.message(`⚠️ *Subscription Expired*

Your 14-day free trial has ended.

Please pay KES 299 to continue using DukaApp.

Reply *PAY NOW* to make payment via M-Pesa STK Push.`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // PAY NOW COMMAND - Initiate STK Push
  // ============================================================
  
  if (incomingMsg === 'pay now' || incomingMsg === 'pay') {
    // Check if already subscribed
    if (subscription.status === 'active') {
      const endDate = new Date(subscription.endDate).toLocaleDateString();
      twiml.message(`✅ *Subscription Active*

Your subscription is active until ${endDate}.

No payment needed at this time.`);
      res.set('Content-Type', 'text/xml');
      res.send(twiml.toString());
      return;
    }
    
    twiml.message(`💰 *Processing Payment*

Please wait while we initiate your M-Pesa STK Push.

💳 Amount: KES 299
🏪 Service: DukaApp Subscription

You will receive a popup on your phone shortly.

Enter your PIN to complete payment.`);
    
    // Initiate STK Push
    const result = await initiateSTKPush(
      userPhone, 
      299, 
      `DukaApp_${userPhone.slice(-8)}`, 
      'DukaApp Subscription'
    );
    
    if (result.success) {
      // Store pending payment
      await db.run(
        `INSERT INTO payments (phone, amount, checkout_request_id, status)
         VALUES (?, ?, ?, 'pending')`,
        userPhone, 299, result.checkoutRequestId
      );
      // Also store in memory for quick callback matching
      pendingPayments[result.checkoutRequestId] = { phone: userPhone, amount: 299 };
      console.log(`💰 STK Push initiated for ${userPhone}, CheckoutID: ${result.checkoutRequestId}`);
    } else {
      console.error(`❌ STK Push failed for ${userPhone}: ${result.error}`);
    }
    
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // REGISTERED USER COMMANDS
  // ============================================================
  
  if (user.registered === 1) {
    console.log(`✅ User already registered: ${user.business_name}`);
    
    // HELP COMMAND
    if (incomingMsg === 'help') {
      let subscriptionInfo = '';
      if (subscription.status === 'trial') {
        subscriptionInfo = `\n🎟️ *Trial: ${subscription.daysLeft} days remaining*`;
      } else if (subscription.status === 'active') {
        subscriptionInfo = `\n✅ *Active: ${subscription.daysLeft} days remaining*`;
      } else if (subscription.status === 'expired') {
        subscriptionInfo = `\n⚠️ *Expired - Send PAY NOW to renew*`;
      }
      
      twiml.message(`📖 *DUKAAPP COMMANDS*${subscriptionInfo}

━━━━━━━━━━━━━━━━━━━━
💰 *Sales & Expenses*
━━━━━━━━━━━━━━━━━━━━
• sale [amount] - Record M-Pesa sale
• expense [amount] - Record M-Pesa expense
• cash [amount] - Record cash sale

━━━━━━━━━━━━━━━━━━━━
📦 *Stock Management*
━━━━━━━━━━━━━━━━━━━━
• stock [product] - Check stock
• addstock [product] [qty] - Add stock
• usestock [product] [qty] - Use stock
• liststock - View all products
• lowstock - Low stock alerts

━━━━━━━━━━━━━━━━━━━━
📊 *Reports*
━━━━━━━━━━━━━━━━━━━━
• profit - Today's profit
• status - Business info

━━━━━━━━━━━━━━━━━━━━
💳 *Subscription*
━━━━━━━━━━━━━━━━━━━━
• pay now - Pay KES 299 via M-Pesa

━━━━━━━━━━━━━━━━━━━━

*Examples:*
sale 1500
addstock sugar 50
profit
pay now`);
    }
    
    // STATUS COMMAND
    else if (incomingMsg === 'status') {
      const products = await listStockProducts(userPhone);
      let subscriptionInfo = '';
      
      if (subscription.status === 'trial') {
        subscriptionInfo = `🎟️ *Free Trial: ${subscription.daysLeft} days remaining*`;
      } else if (subscription.status === 'active') {
        subscriptionInfo = `✅ *Subscription Active: ${subscription.daysLeft} days remaining*`;
      } else if (subscription.status === 'expired') {
        subscriptionInfo = `⚠️ *Subscription Expired - Send PAY NOW to renew*`;
      }
      
      twiml.message(`📋 *BUSINESS STATUS*

🏪 Business: ${user.business_name}
📂 Type: ${user.business_type}
📍 Location: ${user.location}

━━━━━━━━━━━━━━━━━━━━
${subscriptionInfo}
━━━━━━━━━━━━━━━━━━━━
📦 Products in stock: ${products.length}

Type "help" for all commands.`);
    }
    
    // STOCK COMMANDS
    else if (incomingMsg.startsWith('stock')) {
      const parts = incomingMsg.split(' ');
      const productName = parts.slice(1).join(' ');
      
      if (!productName) {
        const products = await listStockProducts(userPhone);
        
        if (products.length === 0) {
          twiml.message(`📦 *No products in inventory*

Add products with: addstock [product] [quantity]

Example: addstock sugar 50`);
        } else {
          let stockList = `📦 *YOUR INVENTORY*\n\n`;
          for (const p of products) {
            const status = p.quantity <= p.reorder_level ? '⚠️ LOW' : '✅';
            stockList += `${status} *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
          }
          twiml.message(stockList);
        }
      } else {
        const product = await getProductStock(userPhone, productName);
        
        if (!product) {
          twiml.message(`❌ Product "${productName}" not found.

Add it with: addstock ${productName} [quantity]`);
        } else {
          const status = product.quantity <= product.reorder_level ? '⚠️ LOW STOCK' : '✅ In stock';
          twiml.message(`📦 *${product.product_name.toUpperCase()}*

📊 Current stock: ${product.quantity} ${product.unit}
Status: ${status}`);
        }
      }
    }
    
    // ADD STOCK COMMAND
    else if (incomingMsg.startsWith('addstock')) {
      const parts = incomingMsg.split(' ');
      if (parts.length < 3) {
        twiml.message(`📦 *Add Stock*

Type: addstock [product] [quantity]

Example: addstock sugar 50`);
      } else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        
        if (isNaN(quantity) || quantity <= 0) {
          twiml.message(`❌ Invalid quantity. Enter a valid number.`);
        } else {
          const result = await addStockProduct(userPhone, productName, quantity);
          
          if (result.success) {
            if (result.isNew) {
              twiml.message(`✅ *New product added!*

📦 ${productName}: ${result.newQty} pcs`);
            } else {
              twiml.message(`✅ *Stock updated!*

📦 ${productName}: ${result.oldQty} → ${result.newQty} pcs`);
            }
          }
        }
      }
    }
    
    // USE STOCK COMMAND
    else if (incomingMsg.startsWith('usestock')) {
      const parts = incomingMsg.split(' ');
      if (parts.length < 3) {
        twiml.message(`📦 *Use Stock*

Type: usestock [product] [quantity]

Example: usestock sugar 5`);
      } else {
        const quantity = parseFloat(parts[parts.length - 1]);
        const productName = parts.slice(1, -1).join(' ');
        
        if (isNaN(quantity) || quantity <= 0) {
          twiml.message(`❌ Invalid quantity.`);
        } else {
          const result = await useStockProduct(userPhone, productName, quantity);
          
          if (result.success) {
            twiml.message(`✅ *Stock used!*

📦 ${result.product}: Used ${result.usedQty} pcs
📊 Remaining: ${result.remainingQty} pcs`);
          } else {
            twiml.message(`❌ ${result.error}`);
          }
        }
      }
    }
    
    // LIST STOCK COMMAND
    else if (incomingMsg === 'liststock') {
      const products = await listStockProducts(userPhone);
      
      if (products.length === 0) {
        twiml.message(`📦 *No products in inventory*

Add products with: addstock [product] [quantity]`);
      } else {
        let stockList = `📦 *COMPLETE INVENTORY*\n\n`;
        for (const p of products) {
          stockList += `• *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
        }
        stockList += `\nTotal: ${products.length} products`;
        twiml.message(stockList);
      }
    }
    
    // LOW STOCK COMMAND
    else if (incomingMsg === 'lowstock') {
      const lowProducts = await getLowStockProducts(userPhone);
      
      if (lowProducts.length === 0) {
        twiml.message(`✅ *No low stock items*

All products are well stocked.`);
      } else {
        let alertMsg = `⚠️ *LOW STOCK ALERT*\n\n`;
        for (const p of lowProducts) {
          alertMsg += `📦 ${p.product_name}: ${p.quantity} ${p.unit} left\n`;
        }
        alertMsg += `\nRestock with: addstock [product] [quantity]`;
        twiml.message(alertMsg);
      }
    }
    
    // SALE COMMAND
    else if (incomingMsg.startsWith('sale')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) {
        await db.run(
          `INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'sale')`,
          userPhone, amount
        );
        twiml.message(`✅ *Sale Recorded!* KES ${amount}`);
      } else {
        twiml.message(`📊 *Record a Sale*

Type: sale [amount]
Example: sale 1500`);
      }
    }
    
    // EXPENSE COMMAND
    else if (incomingMsg.startsWith('expense')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) {
        await db.run(
          `INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'expense')`,
          userPhone, amount
        );
        twiml.message(`✅ *Expense Recorded!* KES ${amount}`);
      } else {
        twiml.message(`💸 *Record an Expense*

Type: expense [amount]
Example: expense 500`);
      }
    }
    
    // CASH COMMAND
    else if (incomingMsg.startsWith('cash')) {
      const amount = incomingMsg.split(' ')[1];
      if (amount && !isNaN(amount)) {
        await db.run(
          `INSERT INTO transactions (phone, amount, type) VALUES (?, ?, 'cash_sale')`,
          userPhone, amount
        );
        twiml.message(`✅ *Cash Sale Recorded!* KES ${amount}`);
      } else {
        twiml.message(`💵 *Record a Cash Sale*

Type: cash [amount]
Example: cash 1000`);
      }
    }
    
    // PROFIT COMMAND
    else if (incomingMsg === 'profit') {
      const today = new Date().toISOString().split('T')[0];
      
      const sales = await db.get(
        `SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type IN ('sale', 'cash_sale') AND date = ?`,
        userPhone, today
      );
      const expenses = await db.get(
        `SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date = ?`,
        userPhone, today
      );
      
      const totalSales = sales?.total || 0;
      const totalExpenses = expenses?.total || 0;
      const profit = totalSales - totalExpenses;
      
      twiml.message(`📊 *TODAY'S PROFIT*

💰 Sales: KES ${totalSales}
💸 Expenses: KES ${totalExpenses}
━━━━━━━━━━━━━━━━━━━━
📈 PROFIT: KES ${profit}`);
    }
    
    // AGENT COMMAND
    else if (incomingMsg === 'agent') {
      twiml.message(`🤝 *Become a DukaApp Agent*

• KES 200 per shop you sign up
• 10% recurring commission

Start here: https://dukaapp.online/agent-signup`);
    }
    
    // DEFAULT RESPONSE
    else {
      twiml.message(`❌ Command not recognized.

Type *help* to see all commands.

Examples:
• sale 1500
• addstock sugar 50
• profit
• pay now`);
    }
    
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // REGISTRATION FLOW (Only for NEW users)
  // ============================================================
  
  // Step 2: Waiting for business name
  if (user.step === 'waiting_for_business_name') {
    await updateUser(userPhone, { business_name: incomingMsg, step: 'waiting_for_business_type' });
    twiml.message(`Great! What type of business do you run?\n\nExamples: Retail Shop, Grocery, Hardware, Restaurant, Salon, Boutique, etc.\n\nType your business type.`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // Step 3: Waiting for business type
  if (user.step === 'waiting_for_business_type') {
    await updateUser(userPhone, { business_type: incomingMsg, step: 'waiting_for_location' });
    twiml.message(`Where is your business located?\n\nExamples: Nairobi, Mombasa, Kisumu, Nakuru, etc.\n\nType your location.`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // Step 4: Waiting for location - Complete registration
  if (user.step === 'waiting_for_location') {
    await updateUser(userPhone, { location: incomingMsg, registered: 1, step: 'none' });
    
    user = await getUser(userPhone);
    
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

━━━━━━━━━━━━━━━━━━━━
📦 *STOCK MANAGEMENT*
━━━━━━━━━━━━━━━━━━━━
• stock [product] - Check stock
• addstock [product] [qty] - Add stock
• usestock [product] [qty] - Use stock
• liststock - View all products
• lowstock - Low stock alerts

━━━━━━━━━━━━━━━━━━━━
💳 *SUBSCRIPTION*
━━━━━━━━━━━━━━━━━━━━
You have a *14-day free trial*!

After trial: KES 299/month
Reply *PAY NOW* to subscribe early

━━━━━━━━━━━━━━━━━━━━
🤖 *AUTO-RECORDING*
━━━━━━━━━━━━━━━━━━━━

Just forward your M-Pesa messages!
• Received money → Auto-sale
• Sent money → Auto-expense

━━━━━━━━━━━━━━━━━━━━

Type *HELP* anytime to see all commands.

Thank you for choosing DukaApp! 🚀`;
    
    twiml.message(welcomeMsg);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // START COMMAND - Begin registration
  // ============================================================
  
  if (incomingMsg === 'start') {
    await updateUser(userPhone, { step: 'waiting_for_business_name' });
    twiml.message(`🎉 *Welcome to DukaApp!* 🎉

Let's get your business registered.

*Step 1 of 3:* What is your business name?

Type your business name (e.g., "Katungu General Store")`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // DEFAULT RESPONSE FOR UNREGISTERED USERS
  // ============================================================
  
  twiml.message(`👋 *Welcome to DukaApp!* 👋

Track sales, expenses, and profit on WhatsApp.

To begin your 14-day free trial, reply: *START*

We'll ask for your business name, type, and location.

Questions? Reply: SUPPORT`);
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ============================================================
// START TRIAL PAGE (Redirect)
// ============================================================

app.get('/start-trial', (req, res) => {
  res.redirect('https://wa.me/14155238886?text=start');
});

// ============================================================
// AGENT SIGNUP PAGE
// ============================================================

app.get('/agent-signup', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Become a DukaApp Agent</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                margin: 0;
            }
            .card {
                background: white;
                border-radius: 30px;
                padding: 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
            }
            h1 { color: #333; margin-bottom: 10px; }
            .subtitle { color: #666; margin-bottom: 30px; }
            .commission {
                background: #f0fdf4;
                border-radius: 20px;
                padding: 20px;
                margin: 20px 0;
            }
            .commission h3 { color: #28a745; font-size: 28px; margin: 0; }
            .btn {
                background: #25D366;
                color: white;
                padding: 15px 30px;
                border-radius: 50px;
                text-decoration: none;
                display: inline-block;
                font-weight: 600;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>🚀 Become a DukaApp Agent</h1>
            <p class="subtitle">Earn KES 200 per shop + 10% monthly recurring commission</p>
            <div class="commission">
                <h3>KES 200</h3>
                <p>per shop signup bonus</p>
                <p style="font-size: 14px;">+ 10% of subscription (KES 30/month for 3 months)</p>
            </div>
            <p>To become an agent, send "agent" to our WhatsApp number.</p>
            <a href="https://wa.me/14155238886?text=agent" class="btn">Start on WhatsApp →</a>
        </div>
    </body>
    </html>
  `);
});

app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Agent Dashboard - DukaApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #f0f2f5;
                margin: 0;
                padding: 20px;
            }
            .container { max-width: 800px; margin: 0 auto; }
            .card {
                background: white;
                border-radius: 20px;
                padding: 30px;
                margin-bottom: 20px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 { color: #0F2B3D; margin-top: 0; }
            .alert {
                background: #fff3cd;
                border: 1px solid #ffecb5;
                padding: 15px;
                border-radius: 10px;
                margin: 20px 0;
                color: #856404;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>🤝 Agent Dashboard</h1>
                <div class="alert">
                    Please send "agent" to our WhatsApp number to get your agent code.
                </div>
                <a href="https://wa.me/14155238886?text=agent" style="background:#25D366; color:white; padding:12px 24px; text-decoration:none; border-radius:8px; display:inline-block;">Start on WhatsApp →</a>
            </div>
        </div>
    </body>
    </html>
  `);
});

// ============================================================
// DAILY SUBSCRIPTION CHECK (Run every hour)
// ============================================================

async function dailySubscriptionCheck() {
  console.log('🔄 Running subscription check...');
  
  // Check for trials expiring tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 19);
  
  const expiringTrials = await db.all(
    `SELECT * FROM users 
     WHERE subscription_status = 'trial' 
     AND trial_end_date <= ?`,
    tomorrowStr
  );
  
  for (const user of expiringTrials) {
    console.log(`⚠️ Trial expires soon for ${user.phone}`);
    // Here you could send WhatsApp reminders
  }
  
  // Check for expired trials
  await checkExpiredTrials();
}

// Run subscription check every hour
setInterval(dailySubscriptionCheck, 60 * 60 * 1000);

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ DukaApp server running on port ${PORT}`);
  console.log(`✅ Health check: /health`);
  console.log(`✅ WhatsApp webhook: /whatsapp`);
  console.log(`✅ M-Pesa STK Push enabled with your sandbox credentials`);
  console.log(`✅ Stock management enabled`);
  console.log(`✅ Permanent user registration enabled`);
  console.log(`✅ Subscription management enabled`);
});
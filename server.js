// server.js - Complete DukaApp Server with Stock Management
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const app = express();

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
      registered BOOLEAN DEFAULT 0,
      step TEXT DEFAULT 'none',
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
    
    CREATE TABLE IF NOT EXISTS stock_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      reorder_level REAL DEFAULT 0,
      buying_price REAL DEFAULT 0,
      selling_price REAL DEFAULT 0,
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
}

initDatabase();

// Middleware
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
    await db.run(
      'INSERT INTO users (phone, step) VALUES (?, ?)',
      phone, 'none'
    );
    user = await db.get('SELECT * FROM users WHERE phone = ?', phone);
  }
  return user;
}

async function updateUser(phone, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  await db.run(`UPDATE users SET ${setClause} WHERE phone = ?`, ...values, phone);
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
  
  // ============================================================
  // REGISTRATION FLOW (if not registered)
  // ============================================================
  
  if (!user.registered) {
    
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
      await updateUser(userPhone, { location: incomingMsg, registered: true, step: 'none' });
      
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
*🤖 AUTO-RECORDING*
━━━━━━━━━━━━━━━━━━━━

Just forward your M-Pesa messages!
• Received money → Auto-sale
• Sent money → Auto-expense

━━━━━━━━━━━━━━━━━━━━

You have a *14-day free trial*!

Type *HELP* anytime to see all commands.

Thank you for choosing DukaApp! 🚀`;
      
      twiml.message(welcomeMsg);
      res.set('Content-Type', 'text/xml');
      res.send(twiml.toString());
      return;
    }
    
    // START command - Begin registration
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
    
    // Default response for unregistered users
    twiml.message(`👋 *Welcome to DukaApp!* 👋

Track sales, expenses, and profit on WhatsApp.

To begin your 14-day free trial, reply: *START*

We'll ask for your business name, type, and location.

Questions? Reply: SUPPORT`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // REGISTERED USER COMMANDS
  // ============================================================
  
  // ============================================================
  // HELP COMMAND
  // ============================================================
  
  if (incomingMsg === 'help') {
    twiml.message(`📖 *DUKAAPP COMMANDS*

━━━━━━━━━━━━━━━━━━━━
💰 *Sales & Expenses*
━━━━━━━━━━━━━━━━━━━━
• sale [amount] - Record M-Pesa sale
• expense [amount] - Record M-Pesa expense
• cash [amount] - Record cash sale
• cashexpense [amount] - Record cash expense

━━━━━━━━━━━━━━━━━━━━
📦 *Stock Management* 🆕
━━━━━━━━━━━━━━━━━━━━
• stock [product] - Check stock levels
• addstock [product] [qty] - Add to inventory
• usestock [product] [qty] - Reduce when sold
• liststock - Show all inventory
• lowstock - Show items needing reorder

━━━━━━━━━━━━━━━━━━━━
📊 *Reports*
━━━━━━━━━━━━━━━━━━━━
• profit - Today's profit
• status - Business info

━━━━━━━━━━━━━━━━━━━━
🤝 *Agent Program*
━━━━━━━━━━━━━━━━━━━━
• agent - Join agent program

━━━━━━━━━━━━━━━━━━━━

*Stock examples:*
addstock sugar 50
usestock sugar 5
stock sugar
liststock
lowstock`);
  }
  
  // ============================================================
  // STOCK MANAGEMENT COMMANDS
  // ============================================================
  
  // CHECK STOCK - "stock sugar" or "stock"
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
        twiml.message(`❌ Product "${productName}" not found in inventory.

Add it with: addstock ${productName} [quantity]

Example: addstock ${productName} 20`);
      } else {
        const status = product.quantity <= product.reorder_level ? '⚠️ LOW STOCK - Reorder soon!' : '✅ In stock';
        twiml.message(`📦 *${product.product_name.toUpperCase()}*

📊 Current stock: ${product.quantity} ${product.unit}
📉 Reorder at: ${product.reorder_level} ${product.unit}
Status: ${status}`);
      }
    }
  }
  
  // ADD STOCK - "addstock sugar 50"
  else if (incomingMsg.startsWith('addstock')) {
    const parts = incomingMsg.split(' ');
    if (parts.length < 3) {
      twiml.message(`📦 *Add Stock*

Type: addstock [product name] [quantity]

Example: addstock sugar 50

Optional: addstock sugar 50 kg`);
    } else {
      const quantity = parseFloat(parts[parts.length - 1]);
      const productName = parts.slice(1, -1).join(' ');
      
      if (isNaN(quantity) || quantity <= 0) {
        twiml.message(`❌ Invalid quantity. Please enter a valid number.

Example: addstock sugar 50`);
      } else {
        const result = await addStockProduct(userPhone, productName, quantity);
        
        if (result.success) {
          if (result.isNew) {
            twiml.message(`✅ *New product added!*

📦 ${productName}: ${result.newQty} pcs

Type "liststock" to see all inventory.`);
          } else {
            twiml.message(`✅ *Stock updated!*

📦 ${productName}: ${result.oldQty} → ${result.newQty} pcs

Type "stock ${productName}" for details.`);
          }
        } else {
          twiml.message(`❌ Error: ${result.error}`);
        }
      }
    }
  }
  
  // USE STOCK - "usestock sugar 5"
  else if (incomingMsg.startsWith('usestock')) {
    const parts = incomingMsg.split(' ');
    if (parts.length < 3) {
      twiml.message(`📦 *Use Stock*

When you sell a product, reduce your inventory:

Type: usestock [product] [quantity]

Example: usestock sugar 5`);
    } else {
      const quantity = parseFloat(parts[parts.length - 1]);
      const productName = parts.slice(1, -1).join(' ');
      
      if (isNaN(quantity) || quantity <= 0) {
        twiml.message(`❌ Invalid quantity. Please enter a valid number.

Example: usestock sugar 5`);
      } else {
        const result = await useStockProduct(userPhone, productName, quantity);
        
        if (result.success) {
          twiml.message(`✅ *Stock used!*

📦 ${result.product}: Used ${result.usedQty} pcs
📊 Remaining: ${result.remainingQty} pcs

Type "stock ${result.product}" to check again.`);
        } else {
          twiml.message(`❌ ${result.error}`);
        }
      }
    }
  }
  
  // LIST ALL STOCK - "liststock"
  else if (incomingMsg === 'liststock') {
    const products = await listStockProducts(userPhone);
    
    if (products.length === 0) {
      twiml.message(`📦 *No products in inventory*

Add products with: addstock [product] [quantity]

Example: addstock sugar 50`);
    } else {
      let stockList = `📦 *COMPLETE INVENTORY*\n\n`;
      for (const p of products) {
        const status = p.quantity <= p.reorder_level ? '⚠️' : '✅';
        stockList += `${status} *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
      }
      stockList += `\nTotal products: ${products.length}\n\nType "stock [product]" for details.`;
      twiml.message(stockList);
    }
  }
  
  // LOW STOCK ALERT - "lowstock"
  else if (incomingMsg === 'lowstock') {
    const lowProducts = await getLowStockProducts(userPhone);
    
    if (lowProducts.length === 0) {
      twiml.message(`✅ *No low stock items*

All products are above reorder levels.

Type "liststock" to see full inventory.`);
    } else {
      let alertMsg = `⚠️ *LOW STOCK ALERT* ⚠️\n\nThese products need reordering:\n\n`;
      for (const p of lowProducts) {
        alertMsg += `📦 *${p.product_name}*: ${p.quantity} ${p.unit} left\n`;
        alertMsg += `   Reorder at: ${p.reorder_level} ${p.unit}\n\n`;
      }
      alertMsg += `Type "addstock [product] [quantity]" to restock.`;
      twiml.message(alertMsg);
    }
  }
  
  // ============================================================
  // SALES AND EXPENSES COMMANDS
  // ============================================================
  
  // SALE COMMAND
  else if (incomingMsg.startsWith('sale')) {
    const amount = incomingMsg.split(' ')[1];
    if (amount && !isNaN(amount)) {
      await db.run(
        `INSERT INTO transactions (phone, amount, type, description) VALUES (?, ?, 'sale', ?)`,
        userPhone, amount, incomingMsg
      );
      twiml.message(`✅ *Sale Recorded!*

M-Pesa Sale: KES ${amount}

Send "profit" to see today's total.`);
    } else {
      twiml.message(`📊 *Record a Sale*

Type: sale [amount]
Example: sale 1500`);
    }
  }
  
  // EXPENSE COMMAND
  else if (incomingMsg.startsWith('expense')) {
    const parts = incomingMsg.split(' ');
    const amount = parts[1];
    if (amount && !isNaN(amount)) {
      await db.run(
        `INSERT INTO transactions (phone, amount, type, category, description) VALUES (?, ?, 'expense', ?, ?)`,
        userPhone, amount, parts[2] || 'general', incomingMsg
      );
      twiml.message(`✅ *Expense Recorded!*

M-Pesa Expense: KES ${amount}

Send "profit" to see today's total.`);
    } else {
      twiml.message(`💸 *Record an Expense*

Type: expense [amount]
Example: expense 500`);
    }
  }
  
  // CASH SALE COMMAND
  else if (incomingMsg.startsWith('cash')) {
    const amount = incomingMsg.split(' ')[1];
    if (amount && !isNaN(amount)) {
      await db.run(
        `INSERT INTO transactions (phone, amount, type, description) VALUES (?, ?, 'cash_sale', ?)`,
        userPhone, amount, incomingMsg
      );
      twiml.message(`✅ *Cash Sale Recorded!*

Cash Sale: KES ${amount}

Send "profit" to see today's total.`);
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
    
    twiml.message(`📊 *TODAY'S PROFIT* (${today})

💰 Sales: KES ${totalSales}
💸 Expenses: KES ${totalExpenses}
━━━━━━━━━━━━━━━━━━━━
📈 PROFIT: KES ${profit}

${profit >= 0 ? '🎉 Great work! Keep it up!' : '💔 Try to reduce expenses'}

Type "status" for business info.`);
  }
  
  // STATUS COMMAND
  else if (incomingMsg === 'status') {
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
    
    const products = await listStockProducts(userPhone);
    
    twiml.message(`📋 *BUSINESS STATUS*

🏪 Business: ${user.business_name}
📂 Type: ${user.business_type}
📍 Location: ${user.location}

━━━━━━━━━━━━━━━━━━━━
💰 *TODAY'S FINANCIALS*
━━━━━━━━━━━━━━━━━━━━
Sales: KES ${totalSales}
Expenses: KES ${totalExpenses}
Profit: KES ${profit}

━━━━━━━━━━━━━━━━━━━━
📦 *INVENTORY*
━━━━━━━━━━━━━━━━━━━━
Products in stock: ${products.length}

Type "liststock" to see all items.

━━━━━━━━━━━━━━━━━━━━
🎟️ *14-day free trial active!*

Type "help" for all commands.`);
  }
  
  // AGENT COMMAND
  else if (incomingMsg === 'agent') {
    twiml.message(`🤝 *Become a DukaApp Agent*

• KES 200 per shop you sign up
• 10% recurring commission for 3 months

Sign up here: https://dukaapp.online/agent-signup

Already an agent? Visit:
https://dukaapp.online/dashboard`);
  }
  
  // DEFAULT RESPONSE
  else {
    twiml.message(`❌ *Command not recognized*

"${req.body.Body}" is not a valid command.

Type *HELP* to see all available commands.

Quick examples:
• sale 1500
• expense 500
• addstock sugar 50
• liststock
• lowstock`);
  }
  
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
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ DukaApp server running on port ${PORT}`);
  console.log(`✅ Health check: /health`);
  console.log(`✅ WhatsApp webhook: /whatsapp`);
  console.log(`✅ Stock management commands enabled`);
});
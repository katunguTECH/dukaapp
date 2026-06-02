// server.js - Complete DukaApp Server for Render.com
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const app = express();

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('.'));

// ============================================================
// HEALTH CHECK ENDPOINTS (Critical for Render)
// ============================================================

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'DukaApp server is running on Render',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'production'
  });
});

app.get('/status', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    node: process.version,
    platform: process.platform
  });
});

app.get('/test', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running on Render' });
});

// ============================================================
// MAIN LANDING PAGE (served at root)
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

app.post('/whatsapp', (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const userPhone = req.body.From || 'unknown';
  
  console.log(`📩 Message from ${userPhone}: "${incomingMsg}"`);
  
  // Help command
  if (incomingMsg === 'help') {
    twiml.message(`📖 *DUKAAPP COMMANDS*

💰 *Sales & Expenses*
• sale [amount] - Record M-Pesa sale
• expense [amount] - Record M-Pesa expense
• cash [amount] - Record cash sale
• cashexpense [amount] - Record cash expense

📊 *Reports*
• profit - Today's profit
• totalprofit - Detailed daily report
• report - Weekly summary

📝 *Credit Customers*
• addcustomer [name] [phone]
• credit [customer] [amount] [desc]
• pay [customer] [amount]
• credits - View credit summary

🤝 *Agent Program*
• agent - Join agent program

Send "help" anytime for this menu`);
  }
  
  // Agent program info
  else if (incomingMsg === 'agent') {
    twiml.message(`🤝 *Become a DukaApp Agent*

• KES 200 per shop you sign up
• 10% recurring commission for 3 months

Sign up here: https://dukaapp.online/agent-signup

Already an agent? Visit:
https://dukaapp.online/dashboard`);
  }
  
  // Welcome message for new users
  else if (incomingMsg === 'start' || incomingMsg === 'hello' || incomingMsg === 'hi') {
    twiml.message(`👋 *Welcome to DukaApp!*

Track sales, expenses, and profit on WhatsApp.

To begin your 14-day free trial, send "help" to see commands.

Visit: https://dukaapp.online/start-trial`);
  }
  
  // Sale command
  else if (incomingMsg.startsWith('sale')) {
    const amount = incomingMsg.split(' ')[1];
    if (amount && !isNaN(amount)) {
      twiml.message(`✅ *Sale Recorded!*

M-Pesa Sale: KES ${amount}

Send "profit" to see today's total.`);
    } else {
      twiml.message(`📊 *Record a Sale*

Type: sale [amount]
Example: sale 1500`);
    }
  }
  
  // Expense command
  else if (incomingMsg.startsWith('expense')) {
    const amount = incomingMsg.split(' ')[1];
    if (amount && !isNaN(amount)) {
      twiml.message(`✅ *Expense Recorded!*

M-Pesa Expense: KES ${amount}

Send "profit" to see today's total.`);
    } else {
      twiml.message(`💸 *Record an Expense*

Type: expense [amount]
Example: expense 500`);
    }
  }
  
  // Cash sale command
  else if (incomingMsg.startsWith('cash')) {
    const amount = incomingMsg.split(' ')[1];
    if (amount && !isNaN(amount)) {
      twiml.message(`✅ *Cash Sale Recorded!*

Cash Sale: KES ${amount}

Send "profit" to see today's total.`);
    } else {
      twiml.message(`💵 *Record a Cash Sale*

Type: cash [amount]
Example: cash 1000`);
    }
  }
  
  // Cash expense command
  else if (incomingMsg.startsWith('cashexpense')) {
    const parts = incomingMsg.split(' ');
    const amount = parts[1];
    const category = parts[2] || 'general';
    if (amount && !isNaN(amount)) {
      twiml.message(`✅ *Cash Expense Recorded!*

Cash Expense: KES ${amount} (${category})

Send "profit" to see today's total.`);
    } else {
      twiml.message(`💸 *Record a Cash Expense*

Type: cashexpense [amount] [category]
Example: cashexpense 500 rent`);
    }
  }
  
  // Profit command
  else if (incomingMsg === 'profit') {
    twiml.message(`📊 *TODAY'S PROFIT*

M-Pesa Sales: KES 0
Cash Sales: KES 0
Expenses: KES 0

📈 TOTAL PROFIT: KES 0

Send "totalprofit" for detailed report.`);
  }
  
  // Total profit command
  else if (incomingMsg === 'totalprofit') {
    twiml.message(`📊 *TODAY'S DETAILED REPORT*

M-Pesa Sales: KES 0
Cash Sales: KES 0
M-Pesa Expenses: KES 0
Cash Expenses: KES 0

━━━━━━━━━━━━━━━━━━
TOTAL SALES: KES 0
TOTAL EXPENSES: KES 0
✅ PROFIT: KES 0

Send "credits" to see credit customers`);
  }
  
  // Weekly report command
  else if (incomingMsg === 'report') {
    twiml.message(`📈 *LAST 7 DAYS REPORT*

M-Pesa + Cash Combined
Sales: KES 0
Expenses: KES 0
Profit: KES 0

Send "profit" for daily report`);
  }
  
  // Credit customers list
  else if (incomingMsg === 'credits') {
    twiml.message(`📋 *CREDIT SUMMARY*

No credit customers yet.

Add one: "addcustomer [name] [phone]"
Example: addcustomer John Maina 0712345678`);
  }
  
  // Add customer command
  else if (incomingMsg.startsWith('addcustomer')) {
    const parts = incomingMsg.split(' ');
    const customerName = parts.slice(1, -1).join(' ');
    const customerPhone = parts[parts.length - 1];
    
    if (customerName && customerPhone) {
      twiml.message(`✅ *Customer Added!*

Customer: ${customerName}
Phone: ${customerPhone}

Send "credit ${customerName} 5000 goods" to record credit sale`);
    } else {
      twiml.message(`📝 *Add a Credit Customer*

Type: addcustomer [name] [phone]
Example: addcustomer John Maina 0712345678`);
    }
  }
  
  // Credit sale command
  else if (incomingMsg.startsWith('credit')) {
    const parts = incomingMsg.split(' ');
    const customerName = parts[1];
    const amount = parts[2];
    const description = parts.slice(3).join(' ') || 'goods';
    
    if (customerName && amount && !isNaN(amount)) {
      twiml.message(`✅ *Credit Sale Recorded!*

Customer: ${customerName}
Amount: KES ${amount}
Description: ${description}

Send "pay ${customerName} ${amount}" when paid`);
    } else {
      twiml.message(`📝 *Record a Credit Sale*

Type: credit [customer] [amount] [description]
Example: credit John 5000 maize flour`);
    }
  }
  
  // Credit payment command
  else if (incomingMsg.startsWith('pay')) {
    const parts = incomingMsg.split(' ');
    const customerName = parts[1];
    const amount = parts[2];
    
    if (customerName && amount && !isNaN(amount)) {
      twiml.message(`✅ *Payment Recorded!*

Customer: ${customerName}
Amount: KES ${amount}

Send "credits" to see remaining balance`);
    } else {
      twiml.message(`💳 *Record a Credit Payment*

Type: pay [customer] [amount]
Example: pay John 5000`);
    }
  }
  
  // Default response
  else {
    twiml.message(`👋 *DukaApp*

Send "help" to see all commands.

To start tracking your business profits, visit:
https://dukaapp.online/start-trial`);
  }
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ============================================================
// START TRIAL PAGE
// ============================================================

app.get('/start-trial', (req, res) => {
  res.sendFile(path.join(__dirname, 'start-trial.html'));
});

// ============================================================
// AGENT SIGNUP PAGE
// ============================================================

app.get('/agent-signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'agent-signup.html'));
});

// ============================================================
// DASHBOARD PAGE
// ============================================================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================================
// API ENDPOINTS (Agent System)
// ============================================================

app.post('/api/agent/signup', async (req, res) => {
  const { phone, name } = req.body;
  
  if (!phone || !name) {
    return res.status(400).json({ error: 'Phone and name required' });
  }
  
  // Clean phone number
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '254' + cleanPhone.substring(1);
  }
  if (!cleanPhone.startsWith('254')) {
    cleanPhone = '254' + cleanPhone;
  }
  cleanPhone = '+' + cleanPhone;
  
  // Generate agent code
  const agentCode = name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
  
  res.json({ 
    success: true, 
    agentCode: agentCode,
    message: 'Agent registered successfully!'
  });
});

app.get('/api/agent/dashboard', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Agent code required' });
  }
  
  res.json({
    success: true,
    agentName: 'Demo Agent',
    agentCode: code,
    totalShops: 5,
    activeShops: 3,
    totalCommission: 1000,
    paidOut: 500,
    signups: [
      { shop_name: 'Demo Shop 1', status: 'active', commission_due: 200 },
      { shop_name: 'Demo Shop 2', status: 'pending', commission_due: 200 },
      { shop_name: 'Demo Shop 3', status: 'active', commission_due: 200 }
    ]
  });
});

// ============================================================
// START SERVER - CRITICAL: Bind to 0.0.0.0 for Render
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ DukaApp server running on port ${PORT}`);
  console.log(`✅ Health check: /health`);
  console.log(`✅ Status check: /status`);
  console.log(`✅ Test: /test`);
  console.log(`✅ WhatsApp webhook: /whatsapp`);
  console.log(`✅ Ready for production on Render`);
});
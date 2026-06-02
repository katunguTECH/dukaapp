// server.js - Complete DukaApp Server with Registration Flow
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const app = express();

// In-memory user storage (for demo - use database in production)
const userSessions = {};

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
    node: process.version
  });
});

app.get('/test', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running on Render' });
});

// ============================================================
// MAIN LANDING PAGE
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// WHATSAPP WEBHOOK WITH REGISTRATION FLOW
// ============================================================

app.post('/whatsapp', (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const userPhone = req.body.From || 'unknown';
  
  console.log(`📩 Message from ${userPhone}: "${incomingMsg}"`);
  
  // Get or create user session
  if (!userSessions[userPhone]) {
    userSessions[userPhone] = {
      step: 'none',
      businessName: '',
      businessType: '',
      location: '',
      registered: false
    };
  }
  
  const user = userSessions[userPhone];
  
  // ============================================================
  // REGISTRATION FLOW
  // ============================================================
  
  // Step 2: Waiting for business name
  if (user.step === 'waiting_for_business_name') {
    user.businessName = incomingMsg;
    user.step = 'waiting_for_business_type';
    twiml.message(`Great! What type of business do you run?\n\nExamples: Retail Shop, Grocery, Hardware, Restaurant, Salon, Boutique, etc.\n\nType your business type.`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // Step 3: Waiting for business type
  if (user.step === 'waiting_for_business_type') {
    user.businessType = incomingMsg;
    user.step = 'waiting_for_location';
    twiml.message(`Where is your business located?\n\nExamples: Nairobi, Mombasa, Kisumu, Nakuru, etc.\n\nType your location.`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // Step 4: Waiting for location - Complete registration
  if (user.step === 'waiting_for_location') {
    user.location = incomingMsg;
    user.registered = true;
    user.step = 'none';
    
    const welcomeMsg = `✅ *Registration Complete!* ✅

🎉 Welcome to DukaApp, ${user.businessName}!

Business: ${user.businessType}
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
*🤖 AUTO-RECORDING*
━━━━━━━━━━━━━━━━━━━━

Just forward your M-Pesa messages!
• Received money → Auto-SALE
• Sent money → Auto-EXPENSE

━━━━━━━━━━━━━━━━━━━━

You have a *14-day free trial*!

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
    user.step = 'waiting_for_business_name';
    twiml.message(`🎉 *Welcome to DukaApp!* 🎉

Let's get your business registered.

*Step 1 of 3:* What is your business name?

Type your business name (e.g., "Katungu General Store")`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
    return;
  }
  
  // ============================================================
  // REGISTERED USER COMMANDS
  // ============================================================
  
  if (user.registered) {
    
    // HELP COMMAND
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
📊 *Reports*
━━━━━━━━━━━━━━━━━━━━
• profit - Today's profit
• totalprofit - Detailed daily report
• report - Weekly summary

━━━━━━━━━━━━━━━━━━━━
📝 *Credit Customers*
━━━━━━━━━━━━━━━━━━━━
• addcustomer [name] [phone]
• credit [customer] [amount] [desc]
• pay [customer] [amount]
• credits - View credit summary

━━━━━━━━━━━━━━━━━━━━
🤝 *Agent Program*
━━━━━━━━━━━━━━━━━━━━
• agent - Join agent program

━━━━━━━━━━━━━━━━━━━━

*Examples:*
sale 1500
expense 500
cash 1000
profit

Send "help" anytime for this menu`);
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
    
    // SALE COMMAND
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
    
    // EXPENSE COMMAND
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
    
    // CASH SALE COMMAND
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
    
    // CASH EXPENSE COMMAND
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
    
    // PROFIT COMMAND
    else if (incomingMsg === 'profit') {
      twiml.message(`📊 *TODAY'S PROFIT*

M-Pesa Sales: KES 0
Cash Sales: KES 0
Expenses: KES 0

📈 TOTAL PROFIT: KES 0

Send "totalprofit" for detailed report.`);
    }
    
    // STATUS COMMAND
    else if (incomingMsg === 'status') {
      twiml.message(`📋 *BUSINESS STATUS*

Business: ${user.businessName}
Type: ${user.businessType}
Location: ${user.location}

Sales: KES 0
Expenses: KES 0
Profit: KES 0

🎟️ 14-day free trial active!`);
    }
    
    // DEFAULT RESPONSE FOR REGISTERED USERS
    else {
      twiml.message(`❌ *Command not recognized*

"${req.body.Body}" is not a valid command.

Type *HELP* to see all available commands.

Quick examples:
• sale 1500
• expense 500
• profit
• status`);
    }
  }
  
  // ============================================================
  // UNREGISTERED USER (didn't send START)
  // ============================================================
  
  else {
    twiml.message(`👋 *Welcome to DukaApp!* 👋

Track sales, expenses, and profit on WhatsApp.

To begin your 14-day free trial, reply: *START*

We'll ask for your business name, type, and location.

Questions? Reply: SUPPORT`);
  }
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ============================================================
// START TRIAL PAGE (Simple redirect)
// ============================================================

app.get('/start-trial', (req, res) => {
  res.redirect('https://wa.me/14155238886?text=start');
});

// ============================================================
// AGENT SIGNUP PAGE (Placeholder)
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

// ============================================================
// DASHBOARD PAGE
// ============================================================

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
                <a href="https://wa.me/14155238886?text=agent" class="btn" style="background:#25D366; color:white; padding:12px 24px; text-decoration:none; border-radius:8px;">Start on WhatsApp →</a>
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
  console.log(`✅ Registration flow enabled`);
});
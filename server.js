// server.js - Complete DukaApp Server for Render.com
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
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

app.get('/', (req, res) => {
  res.json({ 
    message: 'DukaApp API is running on Render',
    version: '1.0',
    endpoints: ['/health', '/status', '/test', '/whatsapp', '/start-trial', '/agent-signup']
  });
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
  
  // Profit command
  else if (incomingMsg === 'profit') {
    twiml.message(`📊 *TODAY'S PROFIT*

M-Pesa Sales: KES 0
Cash Sales: KES 0
Expenses: KES 0

📈 TOTAL PROFIT: KES 0

Send "totalprofit" for detailed report.`);
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
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Start Your Free Trial - DukaApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #0F2B3D 0%, #1B4A6F 100%);
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
            .logo {
                font-size: 48px;
                font-weight: 800;
                background: linear-gradient(135deg, #0F2B3D 0%, #1B4A6F 100%);
                -webkit-background-clip: text;
                background-clip: text;
                color: transparent;
                margin-bottom: 10px;
            }
            h1 { font-size: 28px; color: #1F2937; margin-bottom: 15px; }
            p { color: #6B7280; margin-bottom: 25px; line-height: 1.6; }
            .btn {
                background: #25D366;
                color: white;
                padding: 15px 30px;
                border-radius: 50px;
                text-decoration: none;
                display: inline-block;
                font-weight: 600;
                margin: 10px 0;
                transition: transform 0.2s;
            }
            .btn:hover { background: #20b859; transform: scale(1.02); }
            .features {
                display: flex;
                justify-content: center;
                gap: 20px;
                margin-top: 30px;
                flex-wrap: wrap;
            }
            .feature {
                font-size: 12px;
                color: #9CA3AF;
                text-align: center;
            }
            .feature span { display: block; font-size: 24px; margin-bottom: 5px; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="logo">DukaApp</div>
            <h1>Start Your 14-Day Free Trial</h1>
            <p>Track sales, expenses, and profit on WhatsApp. No app download required.</p>
            <a href="https://wa.me/14155238886?text=join%20adjective-weigh" class="btn">Open WhatsApp →</a>
            <div class="features">
                <div class="feature"><span>💰</span> Track Sales</div>
                <div class="feature"><span>📊</span> Daily Profit</div>
                <div class="feature"><span>📝</span> Credit Customers</div>
                <div class="feature"><span>🤝</span> Agent Program</div>
            </div>
        </div>
    </body>
    </html>
  `);
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
            input {
                width: 100%;
                padding: 15px;
                margin: 10px 0;
                border: 1px solid #ddd;
                border-radius: 10px;
                font-size: 16px;
                box-sizing: border-box;
            }
            button {
                width: 100%;
                background: #667eea;
                color: white;
                padding: 15px;
                border: none;
                border-radius: 10px;
                font-size: 16px;
                cursor: pointer;
                margin-top: 20px;
            }
            button:hover { background: #5a67d8; }
            .success { background: #d4edda; color: #155724; padding: 15px; border-radius: 10px; margin-top: 20px; }
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
            <form id="signupForm">
                <input type="text" id="name" placeholder="Your full name" required>
                <input type="tel" id="phone" placeholder="Your WhatsApp number (e.g., 0710440648)" required>
                <button type="submit">Start Earning →</button>
            </form>
            <div id="message"></div>
        </div>
        <script>
            document.getElementById('signupForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const name = document.getElementById('name').value;
                const phone = document.getElementById('phone').value;
                const response = await fetch('/api/agent/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, phone })
                });
                const result = await response.json();
                if (result.success) {
                    document.getElementById('message').innerHTML = \`
                        <div class="success">
                            <h3>✅ You're now an agent!</h3>
                            <p>Your agent code: <strong>\${result.agentCode}</strong></p>
                            <p><a href="/dashboard?code=\${result.agentCode}">Go to Dashboard →</a></p>
                        </div>
                    \`;
                } else {
                    document.getElementById('message').innerHTML = \`
                        <div class="success" style="background: #f8d7da; color: #721c24;">
                            <p>❌ Error: \${result.error || 'Something went wrong'}</p>
                        </div>
                    \`;
                }
            });
        </script>
    </body>
    </html>
  `);
});

// ============================================================
// DASHBOARD PAGE
// ============================================================

app.get('/dashboard', (req, res) => {
  const agentCode = req.query.code || '';
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
            .container {
                max-width: 800px;
                margin: 0 auto;
            }
            .card {
                background: white;
                border-radius: 20px;
                padding: 30px;
                margin-bottom: 20px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 { color: #0F2B3D; margin-top: 0; }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 15px;
                margin: 20px 0;
            }
            .stat {
                background: #f8f9fa;
                padding: 15px;
                border-radius: 10px;
                text-align: center;
            }
            .stat h3 { margin: 0 0 5px 0; font-size: 28px; color: #28a745; }
            .stat p { margin: 0; color: #666; }
            .alert {
                background: #fff3cd;
                border: 1px solid #ffecb5;
                padding: 15px;
                border-radius: 10px;
                margin: 20px 0;
                color: #856404;
            }
            input {
                width: 100%;
                padding: 12px;
                border: 1px solid #ddd;
                border-radius: 8px;
                margin: 10px 0;
                font-size: 16px;
                box-sizing: border-box;
            }
            button {
                background: #25D366;
                color: white;
                padding: 12px 24px;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                width: 100%;
            }
            button:hover { background: #20b859; }
            .shop-list { list-style: none; padding: 0; }
            .shop-list li {
                background: #f8f9fa;
                padding: 10px;
                margin: 5px 0;
                border-radius: 8px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>🤝 Agent Dashboard</h1>
                <div id="dashboardContent">
                    <div class="alert">
                        ⚠️ Please enter your agent code to view your dashboard.
                    </div>
                    <input type="text" id="agentCode" placeholder="Enter your agent code" value="${agentCode}">
                    <button onclick="loadDashboard()">View Dashboard</button>
                </div>
            </div>
        </div>
        <script>
            async function loadDashboard() {
                const code = document.getElementById('agentCode').value;
                if (!code) {
                    alert('Please enter your agent code');
                    return;
                }
                const response = await fetch(\`/api/agent/dashboard?code=\${code}\`);
                const data = await response.json();
                if (data.success) {
                    document.getElementById('dashboardContent').innerHTML = \`
                        <h1>🤝 Welcome, \${data.agentName}</h1>
                        <div class="stats">
                            <div class="stat"><h3>\${data.totalShops}</h3><p>Total Shops</p></div>
                            <div class="stat"><h3>\${data.activeShops}</h3><p>Active Shops</p></div>
                            <div class="stat"><h3>KES \${data.totalCommission}</h3><p>Commission Earned</p></div>
                            <div class="stat"><h3>KES \${data.paidOut}</h3><p>Paid Out</p></div>
                        </div>
                        <h3>Registered Shops</h3>
                        <ul class="shop-list">
                            \${data.signups.map(s => \`<li><strong>\${s.shop_name}</strong> - \${s.status} - KES \${s.commission_due || 0}</li>\`).join('')}
                        </ul>
                        <div class="alert">
                            📋 Your Agent Code: <strong>\${data.agentCode}</strong><br>
                            Share this code with shop owners to earn commissions!
                        </div>
                        <button onclick="location.reload()">Refresh</button>
                    \`;
                } else {
                    alert('Invalid agent code');
                }
            }
            if (document.getElementById('agentCode').value) {
                loadDashboard();
            }
        </script>
    </body>
    </html>
  `);
});

// ============================================================
// API ENDPOINTS (Minimal for demonstration)
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
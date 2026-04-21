const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('.'));

let db;

async function initDatabase() {
  db = await open({
    filename: './dukaapp.db',
    driver: sqlite3.Database
  });
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      step TEXT DEFAULT 'welcome',
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
    
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE,
      name TEXT,
      agent_code TEXT UNIQUE,
      commission_rate REAL DEFAULT 0.10,
      total_earned REAL DEFAULT 0,
      paid_out REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS agent_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER,
      shop_phone TEXT,
      shop_name TEXT,
      status TEXT DEFAULT 'pending',
      commission_due REAL,
      commission_paid BOOLEAN DEFAULT 0,
      signup_bonus_paid BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );
    
    CREATE TABLE IF NOT EXISTS agent_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER,
      amount REAL,
      status TEXT DEFAULT 'pending',
      mpesa_ref TEXT,
      paid_at DATETIME,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );
  `);
  console.log('✅ Database ready');
}

initDatabase();

// ==================== AGENT API ENDPOINTS ====================

app.post('/api/agent/signup', async (req, res) => {
  const { phone, name } = req.body;
  
  if (!phone || !name) {
    return res.status(400).json({ error: 'Phone and name required' });
  }
  
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '254' + cleanPhone.substring(1);
  }
  if (!cleanPhone.startsWith('254')) {
    cleanPhone = '254' + cleanPhone;
  }
  cleanPhone = '+' + cleanPhone;
  
  const agentCode = name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
  
  try {
    const existing = await db.get('SELECT * FROM agents WHERE phone = ?', cleanPhone);
    if (existing) {
      return res.json({ success: true, agentCode: existing.agent_code, existing: true });
    }
    
    await db.run(`
      INSERT INTO agents (phone, name, agent_code) 
      VALUES (?, ?, ?)
    `, cleanPhone, name, agentCode);
    
    res.json({ success: true, agentCode: agentCode });
  } catch (error) {
    console.error('Agent signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/dashboard', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Agent code required' });
  }
  
  const agent = await db.get('SELECT * FROM agents WHERE agent_code = ?', code);
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  const signups = await db.all(`
    SELECT * FROM agent_signups 
    WHERE agent_id = ? 
    ORDER BY created_at DESC
  `, agent.id);
  
  const totalShops = signups.length;
  const activeShops = signups.filter(s => s.status === 'active').length;
  const totalCommission = signups.reduce((sum, s) => sum + (s.commission_due || 0), 0);
  
  res.json({
    success: true,
    agentName: agent.name,
    agentCode: agent.agent_code,
    totalShops: totalShops,
    activeShops: activeShops,
    totalCommission: totalCommission,
    paidOut: agent.paid_out || 0,
    signups: signups
  });
});

app.post('/api/agent/register-shop', async (req, res) => {
  const { agentCode, shopPhone, shopName } = req.body;
  
  if (!agentCode || !shopPhone || !shopName) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  const agent = await db.get('SELECT * FROM agents WHERE agent_code = ?', agentCode);
  
  if (!agent) {
    return res.status(404).json({ success: false, message: 'Invalid agent code' });
  }
  
  let cleanShopPhone = shopPhone.replace(/\D/g, '');
  if (cleanShopPhone.startsWith('0')) {
    cleanShopPhone = '254' + cleanShopPhone.substring(1);
  }
  if (!cleanShopPhone.startsWith('254')) {
    cleanShopPhone = '254' + cleanShopPhone;
  }
  cleanShopPhone = '+' + cleanShopPhone;
  
  const existingUser = await db.get('SELECT * FROM users WHERE phone = ?', cleanShopPhone);
  
  if (existingUser) {
    return res.status(400).json({ success: false, message: 'Shop already registered' });
  }
  
  await db.run('INSERT INTO users (phone, name, step) VALUES (?, ?, ?)', cleanShopPhone, shopName, 'welcome');
  
  const commission = 200;
  await db.run(`
    INSERT INTO agent_signups (agent_id, shop_phone, shop_name, commission_due, status)
    VALUES (?, ?, ?, ?, 'pending')
  `, agent.id, cleanShopPhone, shopName, commission);
  
  await db.run('UPDATE agents SET total_earned = total_earned + ? WHERE id = ?', commission, agent.id);
  
  console.log(`📱 Send WhatsApp to ${cleanShopPhone}: Welcome to DukaApp! Your agent ${agent.name} has signed you up. Send "help" to get started.`);
  
  res.json({ 
    success: true, 
    message: `✅ Shop registered! You've earned KES ${commission} commission.`
  });
});

// ==================== AGENT SIGNUP PAGE (INLINE HTML) ====================

app.get('/agent-signup', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Become a DukaApp Agent</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
            }
            .container {
                max-width: 500px;
                margin: auto;
                padding: 20px;
            }
            .card {
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            h1 {
                color: #333;
                margin-bottom: 10px;
            }
            .subtitle {
                color: #666;
                margin-bottom: 30px;
            }
            input {
                width: 100%;
                padding: 15px;
                margin: 10px 0;
                border: 1px solid #ddd;
                border-radius: 10px;
                font-size: 16px;
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
            .success {
                background: #d4edda;
                color: #155724;
                padding: 15px;
                border-radius: 10px;
                margin-top: 20px;
            }
            .commission-box {
                background: #f0f0f0;
                border-radius: 10px;
                padding: 15px;
                margin: 20px 0;
                text-align: center;
            }
            .commission-box h3 { color: #28a745; font-size: 24px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>🚀 Become a DukaApp Agent</h1>
                <p class="subtitle">Earn KES 200 per shop + 10% monthly recurring commission</p>
                
                <div class="commission-box">
                    <h3>KES 200</h3>
                    <p>per shop signup bonus</p>
                    <p style="font-size: 14px;">+ 10% of their subscription (KES 30/month for 3 months)</p>
                </div>
                
                <form id="signupForm">
                    <input type="text" id="name" placeholder="Your full name" required>
                    <input type="tel" id="phone" placeholder="Your WhatsApp number (e.g., 0710440648)" required>
                    <button type="submit">Start Earning →</button>
                </form>
                <div id="message"></div>
            </div>
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
                            <p><a href="/dashboard?code=\${result.agentCode}" style="color: #667eea;">Go to Dashboard →</a></p>
                        </div>
                    \`;
                }
            });
        </script>
    </body>
    </html>
  `);
});

// ==================== DASHBOARD PAGE ====================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ==================== CUSTOM WHATSAPP REDIRECT PAGE ====================

app.get('/start-trial', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Redirecting to WhatsApp - DukaApp</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                background: linear-gradient(135deg, #0F2B3D 0%, #1B4A6F 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            
            .card {
                background: white;
                border-radius: 30px;
                padding: 40px;
                max-width: 500px;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                animation: fadeIn 0.5s ease;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .logo {
                font-size: 48px;
                font-weight: 800;
                background: linear-gradient(135deg, #0F2B3D 0%, #1B4A6F 100%);
                -webkit-background-clip: text;
                background-clip: text;
                color: transparent;
                margin-bottom: 20px;
            }
            
            .whatsapp-icon {
                background: #25D366;
                width: 80px;
                height: 80px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 20px;
            }
            
            .whatsapp-icon svg {
                width: 50px;
                height: 50px;
            }
            
            h1 {
                color: #1F2937;
                margin-bottom: 15px;
                font-size: 28px;
            }
            
            p {
                color: #6B7280;
                margin-bottom: 25px;
                line-height: 1.6;
            }
            
            .loading {
                display: inline-block;
                width: 40px;
                height: 40px;
                border: 4px solid #e5e7eb;
                border-top-color: #25D366;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 20px 0;
            }
            
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            
            .manual-link {
                background: #F3F4F6;
                padding: 15px;
                border-radius: 15px;
                margin-top: 20px;
            }
            
            .manual-link p {
                margin-bottom: 10px;
                font-size: 14px;
            }
            
            .manual-link a {
                color: #25A55C;
                text-decoration: none;
                word-break: break-all;
            }
            
            .btn {
                background: #25D366;
                color: white;
                padding: 12px 24px;
                border-radius: 40px;
                text-decoration: none;
                display: inline-block;
                margin-top: 15px;
                font-weight: 600;
            }
            
            .countdown {
                font-size: 14px;
                color: #9CA3AF;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="logo">DukaApp</div>
            <div class="whatsapp-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white">
                    <path d="M12.04 2.5c-5.3 0-9.6 4.3-9.6 9.6 0 1.7.4 3.3 1.2 4.8L2.5 22l5.2-1.4c1.4.7 3 1.1 4.6 1.1 5.3 0 9.6-4.3 9.6-9.6 0-5.3-4.3-9.6-9.6-9.6z"/>
                    <path fill="white" d="M12.04 4.5c4.2 0 7.6 3.4 7.6 7.6 0 4.2-3.4 7.6-7.6 7.6-1.4 0-2.7-.4-3.8-1L5.5 20l1.3-4.8c-.6-1.1-.9-2.3-.9-3.6 0-4.2 3.4-7.6 7.6-7.6z"/>
                </svg>
            </div>
            <h1>Opening WhatsApp...</h1>
            <p>You'll be redirected to WhatsApp to start your free trial with DukaApp.</p>
            <div class="loading"></div>
            <p class="countdown">Redirecting in <span id="countdown">5</span> seconds...</p>
            
            <div class="manual-link">
                <p>📱 Didn't redirect automatically?</p>
                <p>Click the button below or copy this message:</p>
                <p><code style="background:#e5e7eb; padding:5px 10px; border-radius:8px;">join grain-produce</code></p>
                <a href="https://wa.me/14155238886?text=join%20grain-produce" class="btn" id="manualButton">
                    Open WhatsApp →
                </a>
            </div>
        </div>
        
        <script>
            let seconds = 5;
            const countdownEl = document.getElementById('countdown');
            
            const countdownInterval = setInterval(() => {
                seconds--;
                countdownEl.textContent = seconds;
                if (seconds <= 0) {
                    clearInterval(countdownInterval);
                    window.location.href = 'https://wa.me/14155238886?text=join%20grain-produce';
                }
            }, 1000);
            
            document.getElementById('manualButton').addEventListener('click', () => {
                clearInterval(countdownInterval);
            });
        </script>
    </body>
    </html>
  `);
});

// ==================== WHATSAPP WEBHOOK ====================

app.post('/whatsapp', async (req, res) => {
  console.log('📩 Webhook received:', req.body);
  
  const twiml = new MessagingResponse();
  
  if (!req.body || !req.body.Body) {
    console.error('❌ Invalid request body:', req.body);
    twiml.message('Technical error. Please try again.');
    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }
  
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const userPhone = req.body.From;
  
  console.log(`📱 From: ${userPhone}, Message: ${incomingMsg}`);
  
  let user = await db.get('SELECT * FROM users WHERE phone = ?', userPhone);
  
  if (!user) {
    await db.run('INSERT INTO users (phone, step) VALUES (?, ?)', userPhone, 'welcome');
    user = await db.get('SELECT * FROM users WHERE phone = ?', userPhone);
  }
  
  let response = await handleMessage(userPhone, incomingMsg, user.step);
  
  twiml.message(response.text);
  
  if (response.nextStep) {
    await db.run('UPDATE users SET step = ? WHERE phone = ?', response.nextStep, userPhone);
  }
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

async function handleMessage(phone, msg, step) {
  switch(step) {
    case 'welcome':
      return {
        text: `👋 Karibu DukaApp!\n\nI'll help you track daily profit.\n\nWhat's your duka name? (e.g., "Mama Joyce Groceries")`,
        nextStep: 'getting_name'
      };
      
    case 'getting_name':
      await db.run('UPDATE users SET name = ? WHERE phone = ?', msg, phone);
      return {
        text: `✅ Great! ${msg} is now set up.\n\nNow send:\n• "sale 1500" for sales\n• "expense 800 stock" for expenses\n\nTry it now:`,
        nextStep: 'active'
      };
      
    case 'active':
      if (msg.startsWith('sale')) {
        let amount = parseFloat(msg.split(' ')[1]);
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO transactions (phone, amount, type, description) VALUES (?, ?, 'sale', ?)`, phone, amount, msg);
          return { text: `✅ Sale: KES ${amount} recorded\n\nSend "profit" to see today's total`, nextStep: 'active' };
        } else {
          return { text: `❌ Please specify amount. Example: "sale 1500"`, nextStep: 'active' };
        }
      }
      
      else if (msg.startsWith('expense')) {
        let parts = msg.split(' ');
        let amount = parseFloat(parts[1]);
        let category = parts[2] || 'general';
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO transactions (phone, amount, type, category, description) VALUES (?, ?, 'expense', ?, ?)`, phone, amount, category, msg);
          return { text: `✅ Expense: KES ${amount} (${category}) recorded\n\nSend "profit" to see today's total`, nextStep: 'active' };
        } else {
          return { text: `❌ Please specify amount. Example: "expense 800 stock"`, nextStep: 'active' };
        }
      }
      
      else if (msg === 'profit') {
        let today = new Date().toISOString().split('T')[0];
        let sales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'sale' AND date = ?`, phone, today);
        let expenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date = ?`, phone, today);
        let salesTotal = sales?.total || 0;
        let expensesTotal = expenses?.total || 0;
        let profit = salesTotal - expensesTotal;
        return { text: `📊 Today's Report (${today})\n\nSales: KES ${salesTotal}\nExpenses: KES ${expensesTotal}\nProfit: KES ${profit}\n\nSend "sale X" or "expense X" to add more`, nextStep: 'active' };
      }
      
      else if (msg === 'help') {
        return { text: `📖 Commands:\n• sale 1500 - Add sale\n• expense 800 stock - Add expense\n• profit - See today's profit\n• report - See weekly summary\n• agent - Become a DukaApp agent`, nextStep: 'active' };
      }
      
      else if (msg === 'report') {
        let sales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'sale' AND date >= date('now', '-7 days')`, phone);
        let expenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date >= date('now', '-7 days')`, phone);
        let salesTotal = sales?.total || 0;
        let expensesTotal = expenses?.total || 0;
        let profit = salesTotal - expensesTotal;
        return { text: `📈 Last 7 Days\n\nSales: KES ${salesTotal}\nExpenses: KES ${expensesTotal}\nProfit: KES ${profit}\n\nSend "profit" for today only`, nextStep: 'active' };
      }
      
      else if (msg === 'agent') {
        return { text: `🤝 Want to earn money with DukaApp?\n\nJoin our agent program!\n\n• KES 200 per shop you sign up\n• 10% recurring commission for 3 months\n\nSign up here: https://dukaapp.online/agent-signup\n\nAlready an agent? Go to: https://dukaapp.online/dashboard?code=YOURCODE`, nextStep: 'active' };
      }
      
      else {
        return { text: `❌ I didn't understand "${msg}".\n\nTry:\n• sale 1500\n• expense 800 stock\n• profit\n• report\n• help\n• agent`, nextStep: 'active' };
      }
      
    default:
      return { text: `Welcome back! Send "help" to see options.`, nextStep: 'active' };
  }
}

// ==================== TEST ROUTES ====================

app.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DukaApp running on port ${PORT}`);
});
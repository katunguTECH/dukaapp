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
    
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      amount REAL,
      type TEXT,
      category TEXT,
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS credit_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_phone TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS credit_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_phone TEXT,
      customer_id INTEGER,
      amount REAL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      due_date DATE,
      date DATE DEFAULT CURRENT_DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES credit_customers(id)
    );
    
    CREATE TABLE IF NOT EXISTS credit_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_sale_id INTEGER,
      amount REAL,
      date DATE DEFAULT CURRENT_DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (credit_sale_id) REFERENCES credit_sales(id)
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

// ==================== HEALTH CHECK ENDPOINT (MUST BE FIRST) ====================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'DukaApp server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/status', (req, res) => {
  res.json({ 
    status: 'ok',
    database: 'connected',
    version: '1.2'
  });
});

app.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

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

// ==================== AGENT SIGNUP PAGE ====================

app.get('/agent-signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'agent-signup.html'));
});

// ==================== DASHBOARD PAGE ====================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ==================== CUSTOM WHATSAPP REDIRECT PAGE ====================

app.get('/start-trial', (req, res) => {
  res.sendFile(path.join(__dirname, 'start-trial.html'));
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
        text: `✅ Great! ${msg} is now set up.\n\nSend "help" to see all commands.\n\nTry: "sale 1500" for M-Pesa sale\nOr "cash 1000" for cash sale`,
        nextStep: 'active'
      };
      
    case 'active':
      // M-PESA TRANSACTIONS
      if (msg.startsWith('sale ')) {
        let amount = parseFloat(msg.split(' ')[1]);
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO transactions (phone, amount, type, description) VALUES (?, ?, 'sale', ?)`, phone, amount, msg);
          return { text: `✅ M-Pesa Sale: KES ${amount} recorded\n\nSend "profit" to see today's total`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "sale 1500"`, nextStep: 'active' };
        }
      }
      
      else if (msg.startsWith('expense ')) {
        let parts = msg.split(' ');
        let amount = parseFloat(parts[1]);
        let category = parts[2] || 'general';
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO transactions (phone, amount, type, category, description) VALUES (?, ?, 'expense', ?, ?)`, phone, amount, category, msg);
          return { text: `✅ M-Pesa Expense: KES ${amount} (${category}) recorded\n\nSend "profit" to see today's total`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "expense 800 stock"`, nextStep: 'active' };
        }
      }
      
      // CASH TRANSACTIONS
      else if (msg.startsWith('cash ')) {
        let amount = parseFloat(msg.split(' ')[1]);
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO cash_transactions (phone, amount, type, description) VALUES (?, ?, 'sale', ?)`, phone, amount, msg);
          return { text: `✅ Cash Sale: KES ${amount} recorded\n\nSend "profit" to see combined totals`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "cash 1500"`, nextStep: 'active' };
        }
      }
      
      else if (msg.startsWith('cashexpense ')) {
        let parts = msg.split(' ');
        let amount = parseFloat(parts[1]);
        let category = parts[2] || 'cash_expense';
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO cash_transactions (phone, amount, type, category, description) VALUES (?, ?, 'expense', ?, ?)`, phone, amount, category, msg);
          return { text: `✅ Cash Expense: KES ${amount} (${category}) recorded\n\nSend "profit" to see combined totals`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "cashexpense 800 rent"`, nextStep: 'active' };
        }
      }
      
      // CREDIT CUSTOMERS
      else if (msg.startsWith('addcustomer ')) {
        let parts = msg.split(' ');
        let customerName = parts.slice(1, -1).join(' ');
        let customerPhone = parts[parts.length - 1];
        
        if (customerName && customerPhone) {
          await db.run(`INSERT INTO credit_customers (shop_phone, customer_name, customer_phone) VALUES (?, ?, ?)`, phone, customerName, customerPhone);
          return { text: `✅ Customer "${customerName}" (${customerPhone}) added!\n\nSend "credit ${customerName} 5000 goods" to record credit sale`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "addcustomer John Maina 0712345678"`, nextStep: 'active' };
        }
      }
      
      // CREDIT SALES
      else if (msg.startsWith('credit ')) {
        let parts = msg.split(' ');
        let customerName = parts[1];
        let amount = parseFloat(parts[2]);
        let description = parts.slice(3).join(' ') || 'goods';
        
        let customer = await db.get(`SELECT * FROM credit_customers WHERE shop_phone = ? AND customer_name LIKE ?`, phone, `%${customerName}%`);
        
        if (!customer) {
          return { text: `❌ Customer "${customerName}" not found.\n\nAdd customer first: "addcustomer ${customerName} [phone]"`, nextStep: 'active' };
        }
        
        if (!isNaN(amount)) {
          await db.run(`INSERT INTO credit_sales (shop_phone, customer_id, amount, description) VALUES (?, ?, ?, ?)`, phone, customer.id, amount, description);
          return { text: `✅ Credit Sale: KES ${amount} to ${customer.customer_name}\nDescription: ${description}\n\nSend "pay ${customerName} ${amount}" when paid`, nextStep: 'active' };
        } else {
          return { text: `❌ Example: "credit John 5000 maize flour"`, nextStep: 'active' };
        }
      }
      
      // CREDIT PAYMENTS
      else if (msg.startsWith('pay ')) {
        let parts = msg.split(' ');
        let customerName = parts[1];
        let amount = parseFloat(parts[2]);
        
        let customer = await db.get(`SELECT * FROM credit_customers WHERE shop_phone = ? AND customer_name LIKE ?`, phone, `%${customerName}%`);
        
        if (!customer) {
          return { text: `❌ Customer "${customerName}" not found.`, nextStep: 'active' };
        }
        
        let pendingCredits = await db.all(`SELECT * FROM credit_sales WHERE customer_id = ? AND status = 'pending' ORDER BY date ASC`, customer.id);
        
        if (pendingCredits.length === 0) {
          return { text: `✅ No pending credits for ${customer.customer_name}`, nextStep: 'active' };
        }
        
        let remainingAmount = amount;
        let payments = [];
        
        for (let credit of pendingCredits) {
          if (remainingAmount <= 0) break;
          let paidAmount = Math.min(credit.amount, remainingAmount);
          await db.run(`INSERT INTO credit_payments (credit_sale_id, amount) VALUES (?, ?)`, credit.id, paidAmount);
          
          let totalPaid = await db.get(`SELECT SUM(amount) as total FROM credit_payments WHERE credit_sale_id = ?`, credit.id);
          if (totalPaid.total >= credit.amount) {
            await db.run(`UPDATE credit_sales SET status = 'paid' WHERE id = ?`, credit.id);
          }
          
          payments.push(`KES ${paidAmount} for ${credit.description}`);
          remainingAmount -= paidAmount;
        }
        
        let responseText = `✅ Received KES ${amount} from ${customer.customer_name}\n\nPayment applied to:\n${payments.join('\n')}`;
        if (remainingAmount > 0) {
          responseText += `\n\nRemaining credit: KES ${remainingAmount}`;
        }
        return { text: responseText, nextStep: 'active' };
      }
      
      // CREDIT SUMMARY
      else if (msg === 'credits') {
        let customers = await db.all(`SELECT * FROM credit_customers WHERE shop_phone = ?`, phone);
        
        if (customers.length === 0) {
          return { text: `📋 No credit customers yet.\n\nAdd one: "addcustomer [name] [phone]"`, nextStep: 'active' };
        }
        
        let summary = `📋 *CREDIT SUMMARY*\n\n`;
        for (let customer of customers) {
          let pendingCredits = await db.all(`SELECT * FROM credit_sales WHERE customer_id = ? AND status = 'pending'`, customer.id);
          let totalDue = pendingCredits.reduce((sum, c) => sum + c.amount, 0);
          
          if (totalDue > 0) {
            summary += `👤 ${customer.customer_name}\n`;
            summary += `   Due: KES ${totalDue}\n`;
            for (let credit of pendingCredits) {
              summary += `   • ${credit.description}: KES ${credit.amount}\n`;
            }
            summary += `\n`;
          }
        }
        return { text: summary, nextStep: 'active' };
      }
      
      // PROFIT REPORTS
      else if (msg === 'profit') {
        let today = new Date().toISOString().split('T')[0];
        
        let mpSales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'sale' AND date = ?`, phone, today);
        let mpExpenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date = ?`, phone, today);
        let cashSales = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'sale' AND date = ?`, phone, today);
        let cashExpenses = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'expense' AND date = ?`, phone, today);
        
        let totalSales = (mpSales?.total || 0) + (cashSales?.total || 0);
        let totalExpenses = (mpExpenses?.total || 0) + (cashExpenses?.total || 0);
        let profit = totalSales - totalExpenses;
        
        let pendingCredits = await db.all(`SELECT cs.amount FROM credit_sales cs JOIN credit_customers cc ON cs.customer_id = cc.id WHERE cc.shop_phone = ? AND cs.status = 'pending'`, phone);
        let totalCredit = pendingCredits.reduce((sum, c) => sum + c.amount, 0);
        
        let response = `📊 *TODAY'S REPORT* (${today})\n\n` +
                       `💳 M-Pesa Sales: KES ${mpSales?.total || 0}\n` +
                       `💵 Cash Sales: KES ${cashSales?.total || 0}\n` +
                       `━━━━━━━━━━━━━━━━━━\n` +
                       `📈 TOTAL SALES: KES ${totalSales}\n` +
                       `📉 TOTAL EXPENSES: KES ${totalExpenses}\n` +
                       `✅ PROFIT: KES ${profit}\n`;
        
        if (totalCredit > 0) {
          response += `\n⚠️ Credit outstanding: KES ${totalCredit}\nSend "credits" for details`;
        }
        return { text: response, nextStep: 'active' };
      }
      
      else if (msg === 'totalprofit') {
        let today = new Date().toISOString().split('T')[0];
        
        let mpSales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'sale' AND date = ?`, phone, today);
        let mpExpenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date = ?`, phone, today);
        let cashSales = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'sale' AND date = ?`, phone, today);
        let cashExpenses = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'expense' AND date = ?`, phone, today);
        
        let totalSales = (mpSales?.total || 0) + (cashSales?.total || 0);
        let totalExpenses = (mpExpenses?.total || 0) + (cashExpenses?.total || 0);
        let profit = totalSales - totalExpenses;
        
        return {
          text: `📊 *TODAY'S COMPLETE REPORT* (${today})\n\n` +
                `💰 M-Pesa Sales: KES ${mpSales?.total || 0}\n` +
                `💵 Cash Sales: KES ${cashSales?.total || 0}\n` +
                `📦 M-Pesa Expenses: KES ${mpExpenses?.total || 0}\n` +
                `💸 Cash Expenses: KES ${cashExpenses?.total || 0}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📈 TOTAL SALES: KES ${totalSales}\n` +
                `📉 TOTAL EXPENSES: KES ${totalExpenses}\n` +
                `✅ PROFIT: KES ${profit}\n\n` +
                `Send "credits" to see credit customers`,
          nextStep: 'active'
        };
      }
      
      else if (msg === 'report') {
        let sales = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'sale' AND date >= date('now', '-7 days')`, phone);
        let expenses = await db.get(`SELECT SUM(amount) as total FROM transactions WHERE phone = ? AND type = 'expense' AND date >= date('now', '-7 days')`, phone);
        let cashSales = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'sale' AND date >= date('now', '-7 days')`, phone);
        let cashExpenses = await db.get(`SELECT SUM(amount) as total FROM cash_transactions WHERE phone = ? AND type = 'expense' AND date >= date('now', '-7 days')`, phone);
        
        let totalSales = (sales?.total || 0) + (cashSales?.total || 0);
        let totalExpenses = (expenses?.total || 0) + (cashExpenses?.total || 0);
        let profit = totalSales - totalExpenses;
        
        return { text: `📈 Last 7 Days\n\nM-Pesa + Cash Combined\nSales: KES ${totalSales}\nExpenses: KES ${totalExpenses}\nProfit: KES ${profit}`, nextStep: 'active' };
      }
      
      // HELP COMMAND
      else if (msg === 'help') {
        return {
          text: `📖 *DUKAAPP COMMANDS*\n\n` +
                `💳 M-PESA:\n• sale [amount]\n• expense [amount] [cat]\n\n` +
                `💵 CASH:\n• cash [amount]\n• cashexpense [amount] [cat]\n\n` +
                `📝 CREDIT:\n• addcustomer [name] [phone]\n• credit [customer] [amount] [desc]\n• pay [customer] [amount]\n• credits\n\n` +
                `📊 REPORTS:\n• profit - Today (M-Pesa + Cash)\n• totalprofit - Detailed combined\n• report - Weekly\n• credits - Credit summary\n\n` +
                `🤝 AGENT:\n• agent - Join agent program\n\n` +
                `Send "agent" to earn commissions!`,
          nextStep: 'active'
        };
      }
      
      else if (msg === 'agent') {
        return {
          text: `🤝 Want to earn money with DukaApp?\n\nJoin our agent program!\n\n• KES 200 per shop you sign up\n• 10% recurring commission for 3 months\n\nSign up here: https://dukaapp.online/agent-signup\n\nAlready an agent? Go to: https://dukaapp.online/dashboard?code=YOURCODE`,
          nextStep: 'active'
        };
      }
      
      else {
        return { text: `❌ Command not recognized.\n\nSend "help" to see all commands.`, nextStep: 'active' };
      }
      
    default:
      return { text: `Welcome back! Send "help" to see options.`, nextStep: 'active' };
  }
}

// ==================== ADMIN DASHBOARD API ====================

// Admin dashboard data
app.get('/api/admin/dashboard', async (req, res) => {
    const { period, startDate, endDate } = req.query;
    
    let dateFilter = '';
    
    // Set date range based on period
    if (startDate && endDate) {
        dateFilter = `AND date(created_at) BETWEEN '${startDate}' AND '${endDate}'`;
    } else if (period === 'daily') {
        dateFilter = `AND date(created_at) = date('now')`;
    } else if (period === 'weekly') {
        dateFilter = `AND date(created_at) >= date('now', '-7 days')`;
    } else if (period === 'monthly') {
        dateFilter = `AND date(created_at) >= date('now', '-30 days')`;
    }
    
    // Get total users
    const totalUsersResult = await db.get(`SELECT COUNT(*) as count FROM users WHERE 1=1 ${dateFilter}`);
    const totalUsers = totalUsersResult?.count || 0;
    
    // Get active trials (users who joined in last 14 days and not paid)
    const activeTrialsResult = await db.get(`
        SELECT COUNT(*) as count FROM users 
        WHERE julianday(date('now')) - julianday(created_at) <= 14
        AND phone NOT IN (SELECT DISTINCT shop_phone FROM agent_signups WHERE commission_paid = 1)
        ${dateFilter}
    `);
    const activeTrials = activeTrialsResult?.count || 0;
    
    // Get paid users (simplified - users with agent signups that converted)
    const paidUsersResult = await db.get(`
        SELECT COUNT(DISTINCT shop_phone) as count FROM agent_signups WHERE status = 'active'
    `);
    const paidUsers = paidUsersResult?.count || 0;
    
    // Calculate conversion rate
    const conversionRate = totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 100) : 0;
    
    // Get chart data (signups over time)
    let chartQuery = `
        SELECT date(created_at) as date, COUNT(*) as count
        FROM users
        WHERE 1=1 ${dateFilter}
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC
    `;
    const chartDataRaw = await db.all(chartQuery);
    
    const chartData = chartDataRaw.map(row => ({
        label: row.date,
        count: row.count
    }));
    
    // Get users list with transaction counts
    const usersQuery = `
        SELECT 
            u.phone,
            u.name,
            date(u.created_at) as trial_start,
            date(u.created_at, '+14 days') as trial_end,
            CASE 
                WHEN julianday(date('now')) - julianday(u.created_at) > 14 THEN 'expired'
                WHEN a.shop_phone IS NOT NULL THEN 'paid'
                ELSE 'trial'
            END as status,
            (SELECT COUNT(*) FROM transactions WHERE phone = u.phone) + 
            (SELECT COUNT(*) FROM cash_transactions WHERE phone = u.phone) as transaction_count
        FROM users u
        LEFT JOIN agent_signups a ON u.phone = a.shop_phone
        WHERE 1=1 ${dateFilter}
        ORDER BY u.created_at DESC
        LIMIT 100
    `;
    const users = await db.all(usersQuery);
    
    res.json({
        success: true,
        stats: {
            totalUsers,
            activeTrials,
            paidUsers,
            conversionRate: `${conversionRate}%`,
            totalTrend: '+0',
            trialTrend: '+0',
            paidTrend: '+0',
            conversionTrend: '+0'
        },
        chartData,
        users
    });
});

// Export to CSV
app.get('/api/admin/export', async (req, res) => {
    const { period, startDate, endDate } = req.query;
    
    let dateFilter = '';
    if (startDate && endDate) {
        dateFilter = `AND date(created_at) BETWEEN '${startDate}' AND '${endDate}'`;
    } else if (period === 'daily') {
        dateFilter = `AND date(created_at) = date('now')`;
    } else if (period === 'weekly') {
        dateFilter = `AND date(created_at) >= date('now', '-7 days')`;
    } else if (period === 'monthly') {
        dateFilter = `AND date(created_at) >= date('now', '-30 days')`;
    }
    
    const users = await db.all(`
        SELECT 
            u.phone,
            u.name,
            date(u.created_at) as trial_start,
            date(u.created_at, '+14 days') as trial_end,
            CASE 
                WHEN julianday(date('now')) - julianday(u.created_at) > 14 THEN 'expired'
                WHEN a.shop_phone IS NOT NULL THEN 'paid'
                ELSE 'trial'
            END as status
        FROM users u
        LEFT JOIN agent_signups a ON u.phone = a.shop_phone
        WHERE 1=1 ${dateFilter}
        ORDER BY u.created_at DESC
    `);
    
    // Create CSV
    let csv = 'Phone,Shop Name,Trial Start,Trial End,Status\n';
    users.forEach(user => {
        csv += `"${user.phone || ''}","${user.name || ''}","${user.trial_start || ''}","${user.trial_end || ''}","${user.status || ''}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=dukaapp-users-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
});

// Serve admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==================== HOME PAGE ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DukaApp running on port ${PORT}`);
});
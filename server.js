const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const Database = require('better-sqlite3');

const app = express();

// IMPORTANT: These must be BEFORE your webhook route
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Initialize database
const db = new Database('dukaapp.db');

// Create database tables
db.exec(`
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
`);

console.log('✅ Database ready');

// WhatsApp webhook endpoint
app.post('/whatsapp', (req, res) => {
  console.log('📩 Webhook received:', req.body); // Debug log
  
  const twiml = new MessagingResponse();
  
  // Check if req.body exists and has the Body property
  if (!req.body || !req.body.Body) {
    console.error('❌ Invalid request body:', req.body);
    twiml.message('Technical error. Please try again.');
    res.set('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }
  
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const userPhone = req.body.From;
  
  console.log(`📱 From: ${userPhone}, Message: ${incomingMsg}`); // Debug log
  
  // Get or create user
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(userPhone);
  
  if (!user) {
    db.prepare('INSERT INTO users (phone, step) VALUES (?, ?)').run(userPhone, 'welcome');
    user = db.prepare('SELECT * FROM users WHERE phone = ?').get(userPhone);
  }
  
  // Route based on user's current step
  let response = handleMessage(userPhone, incomingMsg, user.step);
  
  twiml.message(response.text);
  
  // Update user's step if needed
  if (response.nextStep) {
    db.prepare('UPDATE users SET step = ? WHERE phone = ?').run(response.nextStep, userPhone);
  }
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// Message handler logic
function handleMessage(phone, msg, step) {
  switch(step) {
    case 'welcome':
      return {
        text: `👋 Karibu DukaApp!\n\nI'll help you track daily profit.\n\nWhat's your duka name? (e.g., "Mama Joyce Groceries")`,
        nextStep: 'getting_name'
      };
      
    case 'getting_name':
      db.prepare('UPDATE users SET name = ? WHERE phone = ?').run(msg, phone);
      return {
        text: `✅ Great! ${msg} is now set up.\n\nNow send:\n• "sale 1500" for sales\n• "expense 800 stock" for expenses\n\nTry it now:`,
        nextStep: 'active'
      };
      
    case 'active':
      if (msg.startsWith('sale')) {
        let amount = parseFloat(msg.split(' ')[1]);
        if (!isNaN(amount)) {
          db.prepare(`INSERT INTO transactions (phone, amount, type, description) 
                      VALUES (?, ?, 'sale', ?)`).run(phone, amount, msg);
          return {
            text: `✅ Sale: KES ${amount} recorded\n\nSend "profit" to see today's total`,
            nextStep: 'active'
          };
        } else {
          return {
            text: `❌ Please specify amount. Example: "sale 1500"`,
            nextStep: 'active'
          };
        }
      }
      
      else if (msg.startsWith('expense')) {
        let parts = msg.split(' ');
        let amount = parseFloat(parts[1]);
        let category = parts[2] || 'general';
        
        if (!isNaN(amount)) {
          db.prepare(`INSERT INTO transactions (phone, amount, type, category, description) 
                      VALUES (?, ?, 'expense', ?, ?)`).run(phone, amount, category, msg);
          return {
            text: `✅ Expense: KES ${amount} (${category}) recorded\n\nSend "profit" to see today's total`,
            nextStep: 'active'
          };
        } else {
          return {
            text: `❌ Please specify amount. Example: "expense 800 stock"`,
            nextStep: 'active'
          };
        }
      }
      
      else if (msg === 'profit') {
        let today = new Date().toISOString().split('T')[0];
        let sales = db.prepare(`SELECT SUM(amount) as total FROM transactions 
                                WHERE phone = ? AND type = 'sale' AND date = ?`).get(phone, today);
        let expenses = db.prepare(`SELECT SUM(amount) as total FROM transactions 
                                   WHERE phone = ? AND type = 'expense' AND date = ?`).get(phone, today);
        
        let salesTotal = sales.total || 0;
        let expensesTotal = expenses.total || 0;
        let profit = salesTotal - expensesTotal;
        
        return {
          text: `📊 Today's Report (${today})\n\nSales: KES ${salesTotal}\nExpenses: KES ${expensesTotal}\nProfit: KES ${profit}\n\nSend "sale X" or "expense X" to add more`,
          nextStep: 'active'
        };
      }
      
      else if (msg === 'help') {
        return {
          text: `📖 Commands:\n• sale 1500 - Add sale\n• expense 800 stock - Add expense\n• profit - See today's profit\n• report - See weekly summary`,
          nextStep: 'active'
        };
      }
      
      else if (msg === 'report') {
        let sales = db.prepare(`SELECT SUM(amount) as total FROM transactions 
                                WHERE phone = ? AND type = 'sale' AND date >= date('now', '-7 days')`).get(phone);
        let expenses = db.prepare(`SELECT SUM(amount) as total FROM transactions 
                                   WHERE phone = ? AND type = 'expense' AND date >= date('now', '-7 days')`).get(phone);
        
        let salesTotal = sales.total || 0;
        let expensesTotal = expenses.total || 0;
        let profit = salesTotal - expensesTotal;
        
        return {
          text: `📈 Last 7 Days\n\nSales: KES ${salesTotal}\nExpenses: KES ${expensesTotal}\nProfit: KES ${profit}\n\nSend "profit" for today only`,
          nextStep: 'active'
        };
      }
      
      else {
        return {
          text: `❌ I didn't understand "${msg}".\n\nTry:\n• sale 1500\n• expense 800 stock\n• profit\n• help`,
          nextStep: 'active'
        };
      }
      
    default:
      return {
        text: `Welcome back! Send "help" to see options.`,
        nextStep: 'active'
      };
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DukaApp running on port ${PORT}`);
  console.log(`📱 Expose with: ngrok http ${PORT}`);
});
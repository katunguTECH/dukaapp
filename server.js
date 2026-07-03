// server.js - Complete DukaApp Server with M-Pesa Statement Upload & Analysis
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const app = express();

// ============================================================
// MULTER CONFIGURATION FOR FILE UPLOADS
// ============================================================

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.pdf', '.csv', '.txt'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, CSV, and TXT files are allowed'));
        }
    }
});

// ============================================================
// POSTGRESQL DATABASE CONNECTION - IMPROVED FOR RAILWAY
// ============================================================

let pool;

function initPool() {
    const databaseUrl = process.env.DATABASE_URL || process.env.PG_URL;
    
    if (!databaseUrl) {
        console.error('❌ DATABASE_URL environment variable is not set!');
        console.log('📋 Please set DATABASE_URL in your environment variables.');
        return null;
    }
    
    console.log('📋 Database URL found, connecting...');
    
    pool = new Pool({
        connectionString: databaseUrl,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
    });
    
    pool.on('error', (err) => {
        console.error('❌ Unexpected database error:', err);
    });
    
    return pool;
}

// Initialize pool
initPool();

// Test database connection
async function testDatabaseConnection() {
    if (!pool) {
        console.error('❌ Pool not initialized');
        return false;
    }
    
    try {
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL database successfully');
        client.release();
        return true;
    } catch (err) {
        console.error('❌ Database connection error:', err.message);
        console.log('📋 Please check that DATABASE_URL is set correctly');
        console.log('📋 Connection string format: postgresql://user:pass@host:port/db');
        return false;
    }
}

// Initialize all tables
async function initDatabase() {
    if (!pool) {
        console.error('❌ Cannot initialize database: pool not created');
        setTimeout(initDatabase, 5000);
        return;
    }
    
    let client;
    try {
        client = await pool.connect();
        console.log('✅ Database connection verified, creating tables...');
        
        // Users table
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

        // Subscribers table
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
        console.error('❌ Database init error:', error.message);
        console.log('🔄 Retrying database connection in 5 seconds...');
        setTimeout(initDatabase, 5000);
    } finally {
        if (client) client.release();
    }
}

// Initialize database with retry
setTimeout(() => {
    testDatabaseConnection().then(() => {
        initDatabase();
    });
}, 1000);

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
// M-PESA STATEMENT PARSING FUNCTIONS
// ============================================================

function parseMpesaStatement(text) {
    const transactions = [];
    const lines = text.split('\n');

    const patterns = {
        receipt: /(UG|UE|UF|UD|UC|UB|UA|UZ|UY|UX|UW|UV|UU|UT|US|UR|UQ|UP|UO|UN|UM|UL|UK|UJ|UI|UH|UG|UF|UE|UD|UC|UB|UA)[A-Z0-9]{8,10}/i,
        date: /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/,
        amount: /Ksh\s*([\d,]+(?:\.\d{2})?)/i,
        type: /(Received|Sent|Paid|Transferred|Deposit|Withdrawal|M-Pesa|Pay Bill|Lipa Na M-Pesa|Buy Goods|Agent Deposit|Agent Withdrawal|Customer Transfer)/i,
        sender: /from\s+(.+?)(?:\s+on|$)/i,
        receiver: /to\s+(.+?)(?:\s+on|$)/i,
        balance: /balance\s+is\s+Ksh\s*([\d,]+(?:\.\d{2})?)/i,
        transaction_cost: /charge\s*Ksh\s*([\d,]+(?:\.\d{2})?)/i
    };

    let currentTransaction = {};
    let inTransaction = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (!line || line.includes('M-PESA STATEMENT') || line.includes('SUMMARY') ||
            line.includes('DETAILED STATEMENT') || line.includes('Page')) {
            continue;
        }

        const receiptMatch = line.match(patterns.receipt);
        if (receiptMatch) {
            if (Object.keys(currentTransaction).length > 0) {
                transactions.push(currentTransaction);
            }
            currentTransaction = { receipt: receiptMatch[1], raw: line };
            inTransaction = true;
            continue;
        }

        if (inTransaction) {
            const dateMatch = line.match(patterns.date);
            if (dateMatch) {
                currentTransaction.date = dateMatch[1];
            }

            const amountMatch = line.match(patterns.amount);
            if (amountMatch) {
                currentTransaction.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            }

            if (line.includes('Received') || line.includes('received from') ||
                line.includes('Funds received') || line.includes('Deposit of Funds')) {
                currentTransaction.type = 'received';
                currentTransaction.category = 'sale';
            } else if (line.includes('Sent') || line.includes('Transferred to') ||
                line.includes('Withdrawal') || line.includes('Agent Withdrawal') ||
                line.includes('Pay Bill') || line.includes('Lipa Na M-Pesa') ||
                line.includes('Buy Goods') || line.includes('Merchant Payment')) {
                currentTransaction.type = 'sent';
                currentTransaction.category = 'expense';
            } else if (line.includes('OD Loan')) {
                currentTransaction.type = 'loan';
                currentTransaction.category = 'loan';
            } else if (line.includes('Airtime')) {
                currentTransaction.type = 'airtime';
                currentTransaction.category = 'expense';
            } else if (line.includes('Charge')) {
                currentTransaction.type = 'charge';
                currentTransaction.category = 'expense';
            }

            const senderMatch = line.match(patterns.sender);
            if (senderMatch) {
                currentTransaction.sender = senderMatch[1].trim();
            }

            const receiverMatch = line.match(patterns.receiver);
            if (receiverMatch) {
                currentTransaction.receiver = receiverMatch[1].trim();
            }

            const balanceMatch = line.match(patterns.balance);
            if (balanceMatch) {
                currentTransaction.balance = parseFloat(balanceMatch[1].replace(/,/g, ''));
            }

            const costMatch = line.match(patterns.transaction_cost);
            if (costMatch) {
                currentTransaction.cost = parseFloat(costMatch[1].replace(/,/g, ''));
            }
        }

        if (line.includes('Statement Verification Code') || line.includes('For self-help dial')) {
            if (Object.keys(currentTransaction).length > 0) {
                transactions.push(currentTransaction);
                currentTransaction = {};
                inTransaction = false;
            }
        }
    }

    if (Object.keys(currentTransaction).length > 0) {
        transactions.push(currentTransaction);
    }

    return transactions;
}

function calculateSummary(transactions) {
    let totalSales = 0;
    let totalExpenses = 0;
    let totalReceived = 0;
    let totalSent = 0;
    let totalCharges = 0;
    let transactionCount = transactions.length;
    let businessSales = 0;
    let businessExpenses = 0;

    const businessKeywords = ['stock', 'supplier', 'wholesale', 'vendor', 'shop', 'duka',
        'business', 'store', 'retail', 'inventory', 'order', 'purchase'];

    for (const t of transactions) {
        if (t.type === 'received' || t.category === 'sale') {
            totalReceived += t.amount || 0;
            const desc = (t.sender || t.receiver || '').toLowerCase();
            if (businessKeywords.some(kw => desc.includes(kw))) {
                businessSales += t.amount || 0;
            } else {
                businessSales += t.amount || 0;
            }
            totalSales += t.amount || 0;
        } else if (t.type === 'sent' || t.category === 'expense') {
            totalSent += t.amount || 0;
            const desc = (t.receiver || t.sender || '').toLowerCase();
            if (businessKeywords.some(kw => desc.includes(kw)) ||
                t.category === 'expense' || t.type === 'expense') {
                businessExpenses += t.amount || 0;
            }
            totalExpenses += t.amount || 0;
        }

        if (t.cost) {
            totalCharges += t.cost;
        }
    }

    return {
        totalSales,
        totalExpenses,
        totalReceived,
        totalSent,
        totalCharges,
        transactionCount,
        businessSales,
        businessExpenses,
        netProfit: totalSales - totalExpenses,
        businessProfit: businessSales - businessExpenses
    };
}

function identifyBusinessTransactions(transactions) {
    const businessKeywords = ['stock', 'supplier', 'wholesale', 'vendor', 'shop', 'duka',
        'business', 'store', 'retail', 'inventory', 'order', 'purchase'];
    const personalKeywords = ['rent', 'salary', 'food', 'personal', 'family', 'gift',
        'church', 'school', 'medical', 'hospital'];

    for (const t of transactions) {
        const desc = (t.sender || t.receiver || '').toLowerCase();
        const isBusiness = businessKeywords.some(kw => desc.includes(kw));
        const isPersonal = personalKeywords.some(kw => desc.includes(kw));

        t.isBusiness = isBusiness && !isPersonal;
        t.isPersonal = isPersonal && !isBusiness;

        if (!t.isBusiness && !t.isPersonal) {
            if (t.type === 'received') {
                t.isBusiness = true;
                t.isPersonal = false;
            } else {
                t.isPersonal = true;
                t.isBusiness = false;
            }
        }
    }

    return transactions;
}

// ============================================================
// M-PESA HELPER FUNCTIONS
// ============================================================

async function getMpesaAccessToken() {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    try {
        const response = await axios.get(`${MPESA_API_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` }
        });
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
        const response = await axios.post(`${MPESA_API_BASE}/mpesa/stkpush/v1/processrequest`, data, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });

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

// ============================================================
// USER MANAGEMENT FUNCTIONS
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
            'SELECT subscription_status, trial_end_date, subscription_end_date FROM users WHERE phone = $1', [phone]
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
            now.toISOString(), now.toISOString()
        ]);

        console.log(`📊 New subscriber permanently recorded: ${phone} - ${businessName}`);
        }
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
    let eligibleAmount = 0,
        interestRate = 0,
        repaymentMonths = 0;

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
    } else {
        eligibleAmount = 0;
        interestRate = 15;
        repaymentMonths = 2;
    }

    return {
        creditScore,
        eligibleAmount,
        interestRate,
        repaymentMonths,
        recommendation: creditScore >= 50 ? 'Eligible' : 'Building Credit'
    };
}

// ============================================================
// MIDDLEWARE & STATIC FILES
// ============================================================

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('.'));

// ============================================================
// FILE UPLOAD ENDPOINT WITH PDF PASSWORD SUPPORT
// ============================================================

app.post('/api/upload-statement', upload.single('statement'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const filePath = req.file.path;
        const fileExt = path.extname(req.file.originalname).toLowerCase();
        const password = req.body.password || '';
        let fileContent = '';

        // Handle PDF files
        if (fileExt === '.pdf') {
            try {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                fileContent = pdfData.text;
            } catch (pdfError) {
                // If PDF is password protected and password is provided
                if (pdfError.message.includes('password') && password) {
                    try {
                        const dataBuffer = fs.readFileSync(filePath);
                        const pdfData = await pdfParse(dataBuffer);
                        fileContent = pdfData.text;
                    } catch (pwdError) {
                        fs.unlinkSync(filePath);
                        return res.status(400).json({
                            success: false,
                            error: 'Could not open PDF with the provided password. Please check your password or try a different file format.'
                        });
                    }
                } else {
                    fs.unlinkSync(filePath);
                    return res.status(400).json({
                        success: false,
                        error: 'Could not read PDF. Please try converting to CSV or TXT format, or check if the PDF is password protected.'
                    });
                }
            }
        } else {
            // CSV or TXT files
            fileContent = fs.readFileSync(filePath, 'utf8');
        }

        // Clean up file
        fs.unlinkSync(filePath);

        // Parse the statement
        const transactions = parseMpesaStatement(fileContent);

        if (transactions.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Could not parse statement. Please ensure it\'s a valid M-Pesa statement and try again.'
            });
        }

        const classified = identifyBusinessTransactions(transactions);
        const summary = calculateSummary(transactions);
        
        const userPhone = req.query.phone || 'whatsapp:+254710440648';
        
        const client = await pool.connect();
        let savedCount = 0;
        try {
            for (const t of transactions) {
                if (t.amount && t.date) {
                    await client.query(`
                        INSERT INTO transactions (phone, amount, type, category, description, date, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [userPhone, t.amount, t.type === 'received' ? 'sale' : 'expense',
                        t.category || 'mpesa',
                        `M-Pesa: ${t.receipt} - ${t.sender || t.receiver || 'Unknown'}`,
                        t.date ? t.date.split(' ')[0] : new Date().toISOString().split('T')[0],
                        t.date || new Date().toISOString()
                    ]);
                    savedCount++;
                }
            }
        } finally {
            client.release();
        }

        const period = transactions.length > 0 ?
            `${new Date(transactions[0].date).toLocaleDateString()} - ${new Date(transactions[transactions.length - 1].date).toLocaleDateString()}` :
            'N/A';

        res.json({
            success: true,
            summary: {
                totalSales: summary.totalSales,
                totalExpenses: summary.totalExpenses,
                netProfit: summary.netProfit,
                transactionCount: transactions.length,
                businessSales: summary.businessSales,
                businessExpenses: summary.businessExpenses,
                businessProfit: summary.businessProfit
            },
            period: period,
            savedCount: savedCount,
            transactions: transactions.slice(0, 10)
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ADMIN DASHBOARD PAGES
// ============================================================

app.get('/admin-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

app.get('/upload-statement', (req, res) => {
    res.sendFile(path.join(__dirname, 'upload-statement.html'));
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
// WHATSAPP WEBHOOK - MAIN HANDLER
// ============================================================

app.post('/whatsapp', async (req, res) => {
    const twiml = new MessagingResponse();
    const incomingMsg = req.body.Body ? req.body.Body.trim() : '';
    const incomingMsgLower = incomingMsg.toLowerCase();
    const userPhone = req.body.From || 'unknown';

    console.log(`📩 Message from ${userPhone}: "${incomingMsg.substring(0, 100)}"`);

    let user = await getUser(userPhone);
    const subscription = await getSubscriptionStatus(userPhone);

    console.log(`🔍 User status: registered=${user.registered}, step=${user.step}, name=${user.business_name || 'none'}`);

    // ============================================================
    // M-PESA STATEMENT ANALYSIS - Check if this is a statement text
    // ============================================================

    if (incomingMsg.length > 500 && (incomingMsg.includes('Receipt No.') ||
            incomingMsg.includes('UG') ||
            incomingMsg.includes('Ksh') ||
            incomingMsg.includes('M-PESA'))) {

        twiml.message(`📊 *Processing your M-Pesa statement...*

This may take a moment.

Parsing ${incomingMsg.split('\n').length} lines...`);

        const transactions = parseMpesaStatement(incomingMsg);

        if (transactions.length === 0) {
            twiml.message(`❌ *Could not parse statement*

I couldn't identify any transactions in the text you sent.

Please make sure you:
1. Copy the FULL statement including all transactions
2. Include the receipt numbers (e.g., UG209A...)
3. Send as plain text

Try again or send "UPLOAD" for help.`);
            res.set('Content-Type', 'text/xml');
            res.send(twiml.toString());
            return;
        }

        const classified = identifyBusinessTransactions(transactions);
        const summary = calculateSummary(transactions);

        const client = await pool.connect();
        try {
            let savedCount = 0;
            for (const t of transactions) {
                if (t.amount && t.date) {
                    await client.query(`
                        INSERT INTO transactions (phone, amount, type, category, description, date, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [userPhone, t.amount, t.type === 'received' ? 'sale' : 'expense',
                    t.category || 'mpesa',
                    `M-Pesa: ${t.receipt} - ${t.sender || t.receiver || 'Unknown'}`,
                    t.date ? t.date.split(' ')[0] : new Date().toISOString().split('T')[0],
                    t.date || new Date().toISOString()
                ]);
                    savedCount++;
                }
            }

            twiml.message(`✅ *Analysis Complete!*

━━━━━━━━━━━━━━━━━━━━
📊 *SUMMARY*
━━━━━━━━━━━━━━━━━━━━
📅 Period: ${transactions.length > 0 ? new Date(transactions[0].date).toLocaleDateString() : 'N/A'} - ${transactions.length > 0 ? new Date(transactions[transactions.length - 1].date).toLocaleDateString() : 'N/A'}
📝 Transactions: ${transactions.length}
💾 Saved to database: ${savedCount}
━━━━━━━━━━━━━━━━━━━━
💰 *Total Received:* KES ${summary.totalReceived.toFixed(2)}
💸 *Total Sent:* KES ${summary.totalSent.toFixed(2)}
📈 *Net:* KES ${(summary.totalReceived - summary.totalSent).toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
🏪 *Business Transactions*
━━━━━━━━━━━━━━━━━━━━
💰 Business Sales: KES ${summary.businessSales.toFixed(2)}
💸 Business Expenses: KES ${summary.businessExpenses.toFixed(2)}
📈 Business Profit: KES ${summary.businessProfit.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━

Type *PROFIT* to see your daily profit.
Type *REPORT* for a detailed breakdown.

Your statement has been saved! 🚀`);
        } finally {
            client.release();
        }
        res.set('Content-Type', 'text/xml');
        res.send(twiml.toString());
        return;
    }

    // ============================================================
    // STATEMENT UPLOAD COMMANDS
    // ============================================================

    if (incomingMsgLower.startsWith('upload') || incomingMsgLower === 'statement') {
        twiml.message(`📊 *Upload Your M-Pesa Statement*

You can upload your M-Pesa statement in two ways:

1️⃣ *Send the statement text* - Copy the transaction details and paste them here

2️⃣ *Upload online* - Visit: https://dukaapp.online/upload-statement

*What I'll do:*
✅ Parse all transactions
✅ Calculate your sales and expenses
✅ Identify business vs personal transactions
✅ Show your profit summary

*To get started:*
• Paste your M-Pesa statement text here
• Or visit: https://dukaapp.online/upload-statement

*Note:* Your data is safe and only used for analysis.`);
        res.set('Content-Type', 'text/xml');
        res.send(twiml.toString());
        return;
    }

    // ANALYZE EXISTING TRANSACTIONS
    if (incomingMsgLower === 'analyze') {
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT * FROM transactions WHERE phone = $1 ORDER BY date DESC`, [userPhone]
            );

            if (result.rows.length === 0) {
                twiml.message(`📊 *No transactions found*

You have no transactions recorded.

To get started:
• Upload a statement: send "UPLOAD"
• Or start tracking manually: SALE 1500

Your data will be analyzed automatically!`);
                return;
            }

            let totalSales = 0,
                totalExpenses = 0;
            for (const t of result.rows) {
                if (t.type === 'sale' || t.type === 'cash_sale') {
                    totalSales += t.amount;
                } else if (t.type === 'expense') {
                    totalExpenses += t.amount;
                }
            }

            const profit = totalSales - totalExpenses;
            const days = Math.ceil((new Date() - new Date(result.rows[0].created_at)) / (1000 * 60 * 60 * 24));

            twiml.message(`📊 *BUSINESS ANALYSIS REPORT*

━━━━━━━━━━━━━━━━━━━━
💰 *Total Sales:* KES ${totalSales.toFixed(2)}
💸 *Total Expenses:* KES ${totalExpenses.toFixed(2)}
📈 *Net Profit:* KES ${profit.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━
📅 *Days Tracked:* ${days}
📊 *Daily Average:* KES ${(profit / days).toFixed(2)}

*Upload a full M-Pesa statement for a complete analysis!*

Send "UPLOAD" to get started. 🚀`);
        } finally {
            client.release();
        }
        res.set('Content-Type', 'text/xml');
        res.send(twiml.toString());
        return;
    }

    // M-PESA AUTO-DETECTION (for short messages)
    if (isMpesaMessage(incomingMsg) && user.registered === 1) {
        const parsed = parseMpesaMessage(incomingMsg);
        if (parsed.amount && parsed.amount > 0) {
            const client = await pool.connect();
            try {
                const today = new Date().toISOString().split('T')[0];
                if (parsed.isReceived) {
                    await client.query(`
                        INSERT INTO transactions (phone, amount, type, description, date, created_at)
                        VALUES ($1, $2, 'sale', $3, $4, $5)
                    `, [userPhone, parsed.amount, `Received from ${parsed.sender || 'customer'}`, today, new Date().toISOString()]);
                    twiml.message(`✅ *M-Pesa Sale Auto-Recorded!*

💰 Amount: KES ${parsed.amount.toFixed(2)}
📊 From: ${parsed.sender || 'Customer'}

Type *PROFIT* for full report.`);
                } else {
                    await client.query(`
                        INSERT INTO transactions (phone, amount, type, description, date, created_at)
                        VALUES ($1, $2, 'expense', $3, $4, $5)
                    `, [userPhone, parsed.amount, `Paid to ${parsed.receiver || 'supplier'}`, today, new Date().toISOString()]);
                    twiml.message(`✅ *M-Pesa Expense Auto-Recorded!*

💸 Amount: KES ${parsed.amount.toFixed(2)}
📊 Paid to: ${parsed.receiver || 'Vendor'}

Type *PROFIT* for full report.`);
                }
            } finally {
                client.release();
            }
            res.set('Content-Type', 'text/xml');
            res.send(twiml.toString());
            return;
        }
    }

    // PAY NOW COMMAND
    if (incomingMsgLower === 'pay now' || incomingMsgLower === 'pay') {
        twiml.message(`💰 *Processing Payment*

Please wait while we initiate your M-Pesa STK Push.

💳 Amount: KES 299
🏪 Service: DukaApp Subscription

You will receive a popup on your phone shortly.

Enter your PIN to complete payment.`);

        const result = await initiateSTKPush(userPhone, 299, `DukaApp_${userPhone.slice(-8)}`, 'DukaApp Subscription');
        if (result.success) {
            const client = await pool.connect();
            try {
                await client.query(`INSERT INTO payments (phone, amount, checkout_request_id, status) VALUES ($1, $2, $3, 'pending')`, [userPhone, 299, result.checkoutRequestId]);
                pendingPayments[result.checkoutRequestId] = { phone: userPhone, amount: 299 };
            } finally {
                client.release();
            }
        }
        res.set('Content-Type', 'text/xml');
        res.send(twiml.toString());
        return;
    }

    // ============================================================
    // REGISTERED USER COMMANDS
    // ============================================================

    if (user.registered === 1) {
        console.log(`✅ User IS registered: ${user.business_name}`);

        // LOAN COMMANDS
        if (incomingMsgLower.startsWith('loan')) {
            const parts = incomingMsgLower.split(' ');
            const action = parts[1];

            if (action === 'check' || !action) {
                const eligibility = await calculateLoanEligibility(userPhone);
                twiml.message(`🏦 *Your Credit Score & Loan Eligibility*

━━━━━━━━━━━━━━━━━━━━
📊 Credit Score: ${eligibility.creditScore}/100
━━━━━━━━━━━━━━━━━━━━
${eligibility.recommendation === 'Eligible' ? '✅ You are ELIGIBLE for a loan!' : '📈 Keep tracking your sales to build credit'}

💰 Estimated Loan Amount: KES ${eligibility.eligibleAmount.toLocaleString()}
📉 Interest Rate: ${eligibility.interestRate}% flat
📅 Repayment Period: ${eligibility.repaymentMonths} months
💵 Monthly Installment: KES ${Math.round(eligibility.eligibleAmount * (1 + eligibility.interestRate / 100) / eligibility.repaymentMonths).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━
To apply for a loan, reply: *LOAN APPLY*

*Note:* Higher credit score = better loan terms. Track your daily sales to improve your score!`);
            } else if (action === 'apply') {
                const eligibility = await calculateLoanEligibility(userPhone);
                if (eligibility.creditScore < 50) {
                    twiml.message(`❌ *Loan Application Not Approved*

Your credit score (${eligibility.creditScore}/100) is below our minimum requirement.

*How to improve:*
• Record all your sales daily
• Use DukaApp consistently for 30+ days

Keep using DukaApp and check again in 2 weeks!`);
                } else {
                    const client = await pool.connect();
                    try {
                        await client.query(`
                            INSERT INTO loan_applications (phone, business_name, business_type, business_location, loan_amount, status, credit_score, eligibility, application_date)
                            VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
                        `, [userPhone, user.business_name, user.business_type, user.location, eligibility.eligibleAmount, eligibility.creditScore, eligibility.recommendation, new Date().toISOString()]);
                        twiml.message(`✅ *Loan Application Submitted!*

📊 Credit Score: ${eligibility.creditScore}/100
💰 Requested Amount: KES ${eligibility.eligibleAmount.toLocaleString()}

⏰ We will contact you within 24-48 hours with loan offers.

Reply *CONSENT YES* to share your data with lenders.`);
                    } finally {
                        client.release();
                    }
                }
            } else if (action === 'consent' && parts[2] === 'yes') {
                const client = await pool.connect();
                try {
                    await client.query(`
                        INSERT INTO customer_consent (phone, consent_type, consent_given, consent_date, purpose)
                        VALUES ($1, 'data_sharing', 1, $2, 'Loan application processing')
                    `, [userPhone, new Date().toISOString()]);
                    twiml.message(`✅ *Thank you for your consent!*

Your business data will now be shared with partner lenders.

We will contact you with loan offers within 24 hours.

Type *LOAN STATUS* to check your application status.`);
                } finally {
                    client.release();
                }
            } else if (action === 'status') {
                const client = await pool.connect();
                try {
                    const result = await client.query(`
                        SELECT * FROM loan_applications WHERE phone = $1 ORDER BY application_date DESC LIMIT 1
                    `, [userPhone]);

                    if (result.rows.length === 0) {
                        twiml.message(`📋 *No loan application found*

To apply, type: *LOAN APPLY*`);
                    } else {
                        const app = result.rows[0];
                        twiml.message(`🏦 *Loan Application Status*

━━━━━━━━━━━━━━━━━━━━
📅 Date: ${new Date(app.application_date).toLocaleDateString()}
💰 Amount: KES ${app.loan_amount.toLocaleString()}
📊 Credit Score: ${app.credit_score}/100
📈 Status: ${app.status.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━

We will contact you within 24 hours.`);
                    }
                } finally {
                    client.release();
                }
            } else if (action === 'help') {
                twiml.message(`🏦 *DukaApp Loan Services*

━━━━━━━━━━━━━━━━━━━━
📊 *Check your eligibility*
Type: LOAN CHECK

📝 *Apply for a loan*
Type: LOAN APPLY

📋 *Check application status*
Type: LOAN STATUS

🔒 *Share data with lenders*
Type: CONSENT YES
━━━━━━━━━━━━━━━━━━━━

*Requirements:*
• 30+ days of transaction history
• Consistent daily sales

*Your transaction data helps you get better loan terms!* 🚀`);
            }
            res.set('Content-Type', 'text/xml');
            res.send(twiml.toString());
            return;
        }

        // HELP COMMAND
        if (incomingMsgLower === 'help') {
            let subInfo = subscription.status === 'trial' ? `\n🎟️ *Trial: ${subscription.daysLeft} days remaining*` : subscription.status === 'active' ? `\n✅ *Active: ${subscription.daysLeft} days remaining*` : '';
            twiml.message(`📖 *DUKAAPP COMMANDS*${subInfo}

━━━━━━━━━━━━━━━━━━━━
💰 *Sales & Expenses*
━━━━━━━━━━━━━━━━━━━━
• sale [amount]
• expense [amount] [category]
• cash [amount]

📦 *Stock Management*
━━━━━━━━━━━━━━━━━━━━
• stock [product]
• addstock [product] [qty]
• usestock [product] [qty]
• liststock
• lowstock

📊 *Reports & Analysis*
━━━━━━━━━━━━━━━━━━━━
• profit - Today's profit
• status - Business info
• UPLOAD - Upload M-Pesa statement
• ANALYZE - Analyze transactions

💳 *Subscription*
━━━━━━━━━━━━━━━━━━━━
• pay now - KES 299/month

🏦 *Loans & Credit*
━━━━━━━━━━━━━━━━━━━━
• loan check - Credit score
• loan apply - Apply for loan

🤖 *M-Pesa Auto-Record*
Just forward M-Pesa messages!

Examples: sale 1500, addstock sugar 50, upload, profit`);
        }
        // STATUS COMMAND
        else if (incomingMsgLower === 'status') {
            const client = await pool.connect();
            try {
                const stock = await client.query('SELECT * FROM stock_products WHERE phone = $1', [userPhone]);
                const txns = await client.query('SELECT COUNT(*) as count FROM transactions WHERE phone = $1', [userPhone]);

                twiml.message(`📋 *BUSINESS STATUS*

🏪 Business: ${user.business_name}
📂 Type: ${user.business_type}
📍 Location: ${user.location}

📦 Products in stock: ${stock.rows.length}
📝 Transactions logged: ${txns.rows[0]?.count || 0}

Type *help* for all commands.`);
            } finally {
                client.release();
            }
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
                twiml.message(`📊 *TODAY'S PROFIT*

💰 Sales: KES ${totalSales}
💸 Expenses: KES ${totalExpenses}
━━━━━━━━━━━━━━━━━━━━
📈 PROFIT: KES ${profit}`);
            } finally {
                client.release();
            }
        }
        // STOCK COMMANDS
        else if (incomingMsgLower.startsWith('addstock')) {
            const parts = incomingMsgLower.split(' ');
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
                    const client = await pool.connect();
                    try {
                        const existing = await client.query('SELECT * FROM stock_products WHERE phone = $1 AND product_name = $2', [userPhone, productName]);
                        if (existing.rows.length > 0) {
                            const newQuantity = existing.rows[0].quantity + quantity;
                            await client.query('UPDATE stock_products SET quantity = $1, updated_at = NOW() WHERE phone = $2 AND product_name = $3', [newQuantity, userPhone, productName]);
                            twiml.message(`✅ *Stock updated!*

📦 ${productName}: ${existing.rows[0].quantity} → ${newQuantity} units`);
                        } else {
                            await client.query('INSERT INTO stock_products (phone, product_name, quantity) VALUES ($1, $2, $3)', [userPhone, productName, quantity]);
                            twiml.message(`✅ *New product added!*

📦 ${productName}: ${quantity} units`);
                        }
                    } finally {
                        client.release();
                    }
                }
            }
        } else if (incomingMsgLower.startsWith('usestock')) {
            const parts = incomingMsgLower.split(' ');
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
                    const client = await pool.connect();
                    try {
                        const product = await client.query('SELECT * FROM stock_products WHERE phone = $1 AND product_name = $2', [userPhone, productName]);
                        if (product.rows.length === 0) {
                            twiml.message(`❌ Product "${productName}" not found.`);
                        } else if (product.rows[0].quantity < quantity) {
                            twiml.message(`❌ Insufficient stock. Available: ${product.rows[0].quantity}`);
                        } else {
                            const newQuantity = product.rows[0].quantity - quantity;
                            await client.query('UPDATE stock_products SET quantity = $1, updated_at = NOW() WHERE phone = $2 AND product_name = $3', [newQuantity, userPhone, productName]);
                            twiml.message(`✅ *Stock used!*

📦 ${productName}: ${product.rows[0].quantity} → ${newQuantity} units`);
                        }
                    } finally {
                        client.release();
                    }
                }
            }
        } else if (incomingMsgLower === 'liststock') {
            const client = await pool.connect();
            try {
                const result = await client.query('SELECT product_name, quantity, unit FROM stock_products WHERE phone = $1 ORDER BY product_name', [userPhone]);
                if (result.rows.length === 0) {
                    twiml.message(`📦 *No products in inventory*

Add products with: addstock [product] [quantity]`);
                } else {
                    let stockList = `📦 *COMPLETE INVENTORY*

`;
                    for (const p of result.rows) {
                        stockList += `• *${p.product_name}*: ${p.quantity} ${p.unit}\n`;
                    }
                    stockList += `\nTotal: ${result.rows.length} products`;
                    twiml.message(stockList);
                }
            } finally {
                client.release();
            }
        } else if (incomingMsgLower === 'lowstock') {
            const client = await pool.connect();
            try {
                const result = await client.query(`
                    SELECT product_name, quantity, unit, reorder_level
                    FROM stock_products WHERE phone = $1 AND quantity <= reorder_level ORDER BY quantity ASC
                `, [userPhone]);
                if (result.rows.length === 0) {
                    twiml.message(`✅ *No low stock items*

All products are well stocked.`);
                } else {
                    let alertMsg = `⚠️ *LOW STOCK ALERT*

`;
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
        // FINANCIAL COMMANDS
        else if (incomingMsgLower.startsWith('sale')) {
            const amount = incomingMsgLower.split(' ')[1];
            if (amount && !isNaN(amount)) {
                const client = await pool.connect();
                try {
                    await client.query(`INSERT INTO transactions (phone, amount, type) VALUES ($1, $2, 'sale')`, [userPhone, amount]);
                } finally {
                    client.release();
                }
                twiml.message(`✅ *Sale Recorded!* KES ${amount}`);
            } else {
                twiml.message(`📊 *Record a Sale*

Type: sale [amount]
Example: sale 1500`);
            }
        } else if (incomingMsgLower.startsWith('expense')) {
            const parts = incomingMsgLower.split(' ');
            const amount = parts[1];
            const category = parts[2] || 'general';
            if (amount && !isNaN(amount)) {
                const client = await pool.connect();
                try {
                    await client.query(`INSERT INTO transactions (phone, amount, type, category) VALUES ($1, $2, 'expense', $3)`, [userPhone, amount, category]);
                } finally {
                    client.release();
                }
                twiml.message(`✅ *Expense Recorded!* KES ${amount} (${category})`);
            } else {
                twiml.message(`💸 *Record an Expense*

Type: expense [amount] [category]
Example: expense 500 rent`);
            }
        } else if (incomingMsgLower.startsWith('cash')) {
            const amount = incomingMsgLower.split(' ')[1];
            if (amount && !isNaN(amount)) {
                const client = await pool.connect();
                try {
                    await client.query(`INSERT INTO transactions (phone, amount, type) VALUES ($1, $2, 'cash_sale')`, [userPhone, amount]);
                } finally {
                    client.release();
                }
                twiml.message(`✅ *Cash Sale Recorded!* KES ${amount}`);
            } else {
                twiml.message(`💵 *Record a Cash Sale*

Type: cash [amount]
Example: cash 1000`);
            }
        } else if (incomingMsgLower === 'agent') {
            twiml.message(`🤝 *Become a DukaApp Agent*

• KES 200 per shop you sign up
• 10% recurring commission

Start here: https://dukaapp.online/agent-signup`);
        } else {
            twiml.message(`❌ Command not recognized.

Type *help* to see all commands.

Examples:
• sale 1500
• addstock sugar 50
• profit
• upload`);
        }

        res.set('Content-Type', 'text/xml');
        res.send(twiml.toString());
        return;
    }

    // ============================================================
    // REGISTRATION FLOW (Only for NEW users)
    // ============================================================

    if (user.step === 'waiting_for_business_name') {
        await updateUser(userPhone, { business_name: incomingMsg, step: 'waiting_for_business_type' });
        twiml.message(`Great! What type of business do you run?

Examples: Retail Shop, Grocery, Hardware, Restaurant, Salon, Boutique, etc.

Type your business type.`);
    } else if (user.step === 'waiting_for_business_type') {
        await updateUser(userPhone, { business_type: incomingMsg, step: 'waiting_for_location' });
        twiml.message(`Where is your business located?

Examples: Nairobi, Mombasa, Kisumu, Nakuru, etc.

Type your location.`);
    } else if (user.step === 'waiting_for_location') {
        await updateUser(userPhone, { location: incomingMsg, registered: 1, step: 'none' });
        await recordNewSubscriber(userPhone, user.business_name, user.business_type, incomingMsg);

        twiml.message(`✅ *Registration Complete!* ✅

🎉 Welcome to DukaApp, ${user.business_name}!

Business: ${user.business_type}
Location: ${user.location}

━━━━━━━━━━━━━━━━━━━━
*QUICK START GUIDE*
━━━━━━━━━━━━━━━━━━━━

💰 *SALE 1000* - Record a sale
💸 *EXPENSE 500* - Record an expense
💵 *CASH 1000* - Record a cash sale
📊 *PROFIT* - View your profit
📋 *STATUS* - Check your info
📊 *UPLOAD* - Upload M-Pesa statement

📦 *Stock Management*
• addstock sugar 50 - Add stock
• usestock sugar 5 - Use stock
• liststock - View all

💳 *Subscription*
You have a *14-day free trial*!
After trial: KES 299/month
Reply *PAY NOW* to subscribe early

🏦 *Loans*
Type *LOAN CHECK* to see your credit score!

🤖 *M-Pesa Auto-Record*
Just forward your M-Pesa messages!

Type *HELP* for all commands.

Thank you for choosing DukaApp! 🚀`);
    } else if (incomingMsgLower === 'start') {
        await updateUser(userPhone, { step: 'waiting_for_business_name' });
        twiml.message(`🎉 *Welcome to DukaApp!* 🎉

Let's get your business registered.

*Step 1 of 3:* What is your business name?

Type your business name (e.g., "Katungu General Store")`);
    } else {
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
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ DukaApp server running on port ${PORT}`);
    console.log(`✅ Health check: /health`);
    console.log(`✅ WhatsApp webhook: /whatsapp`);
    console.log(`✅ Admin dashboard: /admin-dashboard (Password: Dallas123!)`);
    console.log(`✅ Upload statement: /upload-statement`);
    console.log(`✅ M-Pesa Statement Analysis enabled`);
    console.log(`✅ M-Pesa Auto-Detection enabled`);
    console.log(`✅ Loan & Credit Scoring enabled`);
    console.log(`✅ Stock management enabled`);
    console.log(`✅ Permanent registration enabled`);
});
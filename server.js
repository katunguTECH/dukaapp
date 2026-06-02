const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'DukaApp server is running',
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

app.get('/', (req, res) => {
  res.json({ 
    message: 'DukaApp API is running',
    endpoints: ['/health', '/status', '/test', '/whatsapp']
  });
});

// WhatsApp webhook
app.post('/whatsapp', (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  
  console.log(`📩 Message: ${incomingMsg}`);
  
  if (incomingMsg === 'help') {
    twiml.message('📖 DukaApp Commands:\n\n• sale [amount]\n• expense [amount]\n• profit\n• cash [amount]\n• credits\n• agent');
  } else {
    twiml.message(`👋 Welcome to DukaApp!\n\nSend "help" to see commands.`);
  }
  
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DukaApp running on port ${PORT}`);
  console.log(`✅ Health check: /health`);
});
# DukaApp - WhatsApp Profit Tracker for Kenyan SMEs

DukaApp helps small shop owners track daily profit, sales, and expenses directly on WhatsApp.

## Features

- 📱 WhatsApp-based interface (no app download)
- 💰 Track sales and expenses
- 📊 Daily profit reports
- 📈 Weekly summaries
- 🇰🇪 Built for Kenyan dukas

## Tech Stack

- Node.js + Express
- SQLite3 database
- Twilio WhatsApp API
- ngrok for local development

## Setup

1. Clone the repository
2. Run 
pm install
3. Create a .env file with your Twilio credentials
4. Run 
pm run dev

## Commands

- sale [amount] - Record a sale
- expense [amount] [category] - Record an expense
- profit - Show today's profit
- eport - Show weekly summary
- help - Show all commands

## Author

Henry Munyoki

## License

ISC

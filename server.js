require('dotenv').config();
const express = require('express');
const path = require('path');
const { register } = require('./src/routes/api');

const app = express();
const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);

app.use(express.json({ limit: '50mb' }));

register(app);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  🚀 Apollo Scraper → http://localhost:${PORT}\n`);
});
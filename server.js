require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const Database = require('better-sqlite3');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.RESEND_API_KEY) {
  console.warn('\n⚠️  RESEND_API_KEY manquant dans .env — les emails ne seront pas envoyés.\n');
}

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

const db = new Database(path.join(__dirname, 'data', 'vickydore.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'client',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    service_price_cents INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    booking_date_label TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'en_attente',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const SERVICES = [
  { name: 'Guidance Express', duration: '30 min', priceCents: 4000, priceLabel: '40,00 $' },
  { name: 'Guidance Intuitive Personnalisée', duration: '60 min', priceCents: 6000, priceLabel: '60,00 $' },
  { name: 'Petit Soin Énergétique', duration: '30 min', priceCents: 4000, priceLabel: '40,00 $' },
  { name: 'Soin Énergétique Complet', duration: '60 min', priceCents: 6000, priceLabel: '60,00 $' },
];

function ensureAdminAccount() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'Vicky_dore@hotmail.com').toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (existing) return;

  const password = process.env.ADMIN_PASSWORD || 'changez-moi-123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`)
    .run('Vicky Doré', adminEmail, hash);
  console.log(`✦ Compte admin créé : ${adminEmail}`);
}
ensureAdminAccount();

app.use(cors({

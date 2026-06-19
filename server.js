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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieSession({
  name: 'vickydore_session',
  keys: [process.env.SESSION_SECRET || 'dev-secret-changez-moi'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Vous devez être connecté.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: "Accès réservé à l'administration." });
  }
  next();
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

app.post('/api/auth/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Champs manquants.' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });

    const normalizedEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec ce courriel.' });

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'client')`)
      .run(name.trim(), normalizedEmail, hash);

    const user = { id: result.lastInsertRowid, name: name.trim(), email: normalizedEmail, role: 'client' };
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ user });
  } catch (err) {
    console.error('Erreur register :', err.message);
    res.status(500).json({ error: "Erreur serveur lors de l'inscription." });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Champs manquants.' });

    const normalizedEmail = email.trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (!row) return res.status(401).json({ error: 'Courriel ou mot de passe incorrect.' });

    const valid = bcrypt.compareSync(password, row.password_hash);
    if (!valid) return res.status(401).json({ error: 'Courriel ou mot de passe incorrect.' });

    req.session.userId = row.id;
    req.session.role = row.role;
    res.json({ user: publicUser(row) });
  } catch (err) {
    console.error('Erreur login :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.json({ user: null });
  res.json({ user: publicUser(row) });
});

app.post('/api/bookings', requireAuth, async (req, res) => {
  try {
    const { serviceIndex, bookingDate, bookingDateLabel, bookingTime, paymentMethod } = req.body;
    const service = SERVICES[serviceIndex];
    if (!service) return res.status(400).json({ error: 'Service invalide.' });
    if (!bookingDate || !bookingTime) return res.status(400).json({ error: 'Date ou heure manquante.' });
    if (!['carte', 'interac'].includes(paymentMethod)) return res.status(400).json({ error: 'Méthode de paiement invalide.' });

    const conflict = db.prepare(`
      SELECT id FROM bookings WHERE booking_date = ? AND booking_time = ? AND status != 'annule'
    `).get(bookingDate, bookingTime);
    if (conflict) return res.status(409).json({ error: "Ce créneau vient d'être réservé par quelqu'un d'autre." });

    const status = paymentMethod === 'carte' ? 'confirme' : 'en_attente';

    const result = db.prepare(`
      INSERT INTO bookings (user_id, service_name, service_price_cents, booking_date, booking_date_label, booking_time, payment_method, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.session.userId, service.name, service.priceCents, bookingDate, bookingDateLabel || bookingDate, bookingTime, paymentMethod, status);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

    try {
      await sendConfirmationEmails({
        clientName: user.name,
        clientEmail: user.email,
        service,
        bookingDateLabel: bookingDateLabel || bookingDate,
        bookingTime,
        paymentMethod,
        status,
      });
    } catch (emailErr) {
      console.error('⚠️  Erreur envoi email :', emailErr.message);
    }

    res.json({ success: true, bookingId: result.lastInsertRowid, status });
  } catch (err) {
    console.error('Erreur création réservation :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la réservation.' });
  }
});

app.get('/api/bookings/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY booking_date DESC, booking_time DESC')
    .all(req.session.userId);
  res.json(rows);
});

app.post('/api/bookings/:id/cancel', requireAuth, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });
  if (booking.user_id !== req.session.userId) return res.status(403).json({ error: "Cette réservation ne vous appartient pas." });

  db.prepare(`UPDATE bookings SET status = 'annule' WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

app.get('/api/bookings/taken', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Paramètre date manquant.' });
  const rows = db.prepare(`SELECT booking_time FROM bookings WHERE booking_date = ? AND status != 'annule'`).all(date);
  res.json({ takenTimes: rows.map(r => r.booking_time) });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT bookings.*, users.name as client_name, users.email as client_email
    FROM bookings
    JOIN users ON users.id = bookings.user_id
    ORDER BY booking_date DESC, booking_time DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/bookings/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['en_attente', 'confirme', 'annule'].includes(status)) return res.status(400).json({ error: 'Statut invalide.' });
  db.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).run(status, req.params.id);
  res.json({ success: true });
});

async function sendConfirmationEmails({ clientName, clientEmail, service, bookingDateLabel, bookingTime, paymentMethod, status }) {
  const methodLabel = paymentMethod === 'carte' ? 'Carte bancaire' : 'Virement Interac';
  const statusLabel = status === 'confirme' ? 'Confirmée' : 'En attente de paiement';

  const clientHtml = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h2 style="color:#A87C2E;">Votre réservation — ${statusLabel} ✦</h2>
      <p>Bonjour ${escapeHtml(clientName)},</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#8A7A74;">Service</td><td style="padding:6px 0;text-align:right;">${escapeHtml(service.name)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Date</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingDateLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Heure</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingTime)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Paiement</td><td style="padding:6px 0;text-align:right;">${methodLabel}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;font-weight:bold;">Total</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${service.priceLabel}</td></tr>
      </table>
      ${paymentMethod === 'interac' ? "<p>Merci d'envoyer votre virement Interac à <strong>Vicky_dore@hotmail.com</strong> pour confirmer votre rendez-vous.</p>" : ''}
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    </div>
  `;

  const adminHtml = `
    <div style="font-family:Georgia,serif;color:#352B28;">
      <h3>Nouvelle réservation</h3>
      <p><strong>${escapeHtml(clientName)}</strong> (${escapeHtml(clientEmail)})</p>
      <p>${escapeHtml(service.name)} — ${escapeHtml(bookingDateLabel)} à ${escapeHtml(bookingTime)}</p>
      <p>Paiement : ${methodLabel} — Statut : ${statusLabel}</p>
    </div>
  `;

  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminAddress = process.env.ADMIN_EMAIL || 'Vicky_dore@hotmail.com';

  await resend.emails.send({ from: fromAddress, to: clientEmail, subject: 'Votre réservation — Vicky Doré', html: clientHtml });
  await resend.emails.send({ from: fromAddress, to: adminAddress, subject: `Nouvelle réservation : ${service.name}`, html: adminHtml });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.listen(PORT, () => {
  console.log(`\n✦ Serveur Vicky Doré démarré : http://localhost:${PORT}\n`);
});

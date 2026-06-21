// ============================================================
// Serveur de TEST — Vicky Doré
// Comptes clients + espace admin + réservations + email
// ============================================================
// Démarrage : npm install puis npm start
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const Database = require('better-sqlite3');
const { Resend } = require('resend');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.RESEND_API_KEY) {
  console.warn('\n⚠️  RESEND_API_KEY manquant dans .env — les emails ne seront pas envoyés.\n');
}

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

// ---------- Base de données SQLite ----------
const db = new Database(path.join(__dirname, 'data', 'vickydore.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    birth_date TEXT,
    city TEXT,
    role TEXT NOT NULL DEFAULT 'client', -- 'client' ou 'admin'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    service_price_cents INTEGER NOT NULL,
    booking_date TEXT NOT NULL,       -- format AAAA-MM-JJ
    booking_date_label TEXT NOT NULL, -- format affichable
    booking_time TEXT NOT NULL,
    payment_method TEXT NOT NULL,     -- 'carte' ou 'interac'
    status TEXT NOT NULL DEFAULT 'en_attente', -- en_attente / confirme / annule
    reminder_sent_at TEXT,            -- NULL = rappel pas encore envoyé
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    duration TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT 'age_minimum_non_respecte',
    blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS testimonials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    rating INTEGER NOT NULL DEFAULT 5,     -- de 1 à 5
    quote TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'en_attente', -- en_attente / approuve / rejete
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Système de conversation entre une cliente connectée et Vicky.
  -- Une seule conversation continue par client : tous les échanges (questions,
  -- réponses de Vicky) restent dans le même fil, classé par ordre chronologique.
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    has_unread_for_admin INTEGER NOT NULL DEFAULT 1, -- 1 = Vicky a un nouveau message non lu
    has_unread_for_client INTEGER NOT NULL DEFAULT 0, -- 1 = le client a une réponse non lue
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Chaque message individuel dans une conversation.
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender TEXT NOT NULL, -- 'client' ou 'admin'
    message TEXT NOT NULL,
    email_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS promo_banner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    image_path TEXT,
    link_url TEXT NOT NULL DEFAULT 'https://www.tiktok.com/@vickyyydore',
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Heures d'ouverture par défaut, une ligne par jour de la semaine (0 = dimanche ... 6 = samedi).
  -- "is_open" = 0 signifie que ce jour est fermé par défaut (ex : dimanche).
  CREATE TABLE IF NOT EXISTS business_hours (
    weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
    is_open INTEGER NOT NULL DEFAULT 1,
    start_time TEXT NOT NULL DEFAULT '09:00',
    end_time TEXT NOT NULL DEFAULT '17:00',
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
    break_between_slots_minutes INTEGER NOT NULL DEFAULT 0,
    break_start TEXT,
    break_end TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Blocages ponctuels créés par Vicky : un jour complet (start_time/end_time
  -- vides) ou une plage d'heures précise sur une date donnée (ex: vacances,
  -- rendez-vous personnel, fermeture exceptionnelle).
  CREATE TABLE IF NOT EXISTS blocked_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocked_date TEXT NOT NULL,   -- format AAAA-MM-JJ
    start_time TEXT,              -- NULL = jour complet bloqué
    end_time TEXT,                -- NULL = jour complet bloqué
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration légère : si la base existait déjà avant l'ajout de birth_date,
// on ajoute la colonne sans perdre les données existantes.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes('birth_date')) {
  db.exec('ALTER TABLE users ADD COLUMN birth_date TEXT');
}
if (!userColumns.includes('city')) {
  db.exec('ALTER TABLE users ADD COLUMN city TEXT');
}

const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!bookingColumns.includes('reminder_sent_at')) {
  db.exec('ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT');
}

// Migration légère : pause configurable entre les créneaux (ajoutée après
// la première version de business_hours).
const businessHoursColumns = db.prepare("PRAGMA table_info(business_hours)").all().map(c => c.name);
if (!businessHoursColumns.includes('break_between_slots_minutes')) {
  db.exec('ALTER TABLE business_hours ADD COLUMN break_between_slots_minutes INTEGER NOT NULL DEFAULT 0');
}

// Initialise la ligne unique de la bannière promo si elle n'existe pas encore.
db.prepare('INSERT OR IGNORE INTO promo_banner (id) VALUES (1)').run();

// ---------- Heures d'ouverture : seed initial (une seule fois) ----------
// Par défaut : ouvert lundi à samedi 9h-17h, fermé le dimanche.
// Reproduit l'ancien comportement codé en dur côté client (isSunday = fermé).
function ensureBusinessHoursSeed() {
  const count = db.prepare('SELECT COUNT(*) as n FROM business_hours').get().n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO business_hours (weekday, is_open, start_time, end_time, slot_duration_minutes)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let weekday = 0; weekday <= 6; weekday++) {
    const isOpen = weekday !== 0; // 0 = dimanche
    insert.run(weekday, isOpen ? 1 : 0, '09:00', '17:00', 30);
  }
  console.log('✦ Heures d\'ouverture par défaut initialisées (fermé le dimanche).');
}
ensureBusinessHoursSeed();

// ---------- Catalogue des services : seed initial (une seule fois) ----------
// Important : la base de données est désormais la source de vérité.
// Ce tableau ne sert qu'à peupler la table "services" la toute première fois
// que le serveur démarre (si la table est vide). Toute modification ultérieure
// se fait via l'espace admin et est enregistrée en base.
const DEFAULT_SERVICES = [
  { name: 'Guidance Express', duration: '30 min', priceCents: 4000, description: "Séance rapide permettant d'obtenir des réponses claires sur une situation précise grâce à la guidance intuitive." },
  { name: 'Guidance Intuitive Personnalisée', duration: '60 min', priceCents: 6000, description: 'Guidance intuitive approfondie incluant tirage de cartes et messages adaptés à votre situation actuelle.' },
  { name: 'Petit Soin Énergétique', duration: '30 min', priceCents: 4000, description: "Soin énergétique ciblé favorisant l'équilibre, l'apaisement et le recentrage." },
  { name: 'Soin Énergétique Complet', duration: '60 min', priceCents: 6000, description: 'Rééquilibrage énergétique complet du corps, du cœur et de l\'esprit.' },
  { name: 'Rencontre Approfondie', duration: '90 min', priceCents: 9000, description: 'Accompagnement complet combinant guidance intuitive et soin énergétique pour une transformation en profondeur.' },
];

function ensureServicesSeed() {
  const count = db.prepare('SELECT COUNT(*) as n FROM services').get().n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO services (sort_order, name, duration, description, price_cents, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  DEFAULT_SERVICES.forEach((s, i) => insert.run(i, s.name, s.duration, s.description, s.priceCents));
  console.log(`✦ Catalogue des services initialisé (${DEFAULT_SERVICES.length} services).`);
}
ensureServicesSeed();

function formatPriceLabel(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' $';
}

function publicService(row) {
  return {
    id: row.id,
    name: row.name,
    duration: row.duration,
    description: row.description,
    priceCents: row.price_cents,
    price: formatPriceLabel(row.price_cents),
    active: !!row.active,
  };
}

function getActiveServices() {
  return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
}

function getServiceById(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
}

// Nombre maximum de services actifs que Vicky peut avoir en même temps
// dans son catalogue (affichés sur le site et proposés à la réservation).
const MAX_ACTIVE_SERVICES = 10;

// ---------- Création automatique du compte admin (Vicky) au démarrage ----------
function ensureAdminAccount() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'message_VD@hotmail.com').toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (existing) return;

  const password = process.env.ADMIN_PASSWORD || 'changez-moi-123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`)
    .run('Vicky Doré', adminEmail, hash);
  console.log(`✦ Compte admin créé : ${adminEmail} (mot de passe défini dans .env -> ADMIN_PASSWORD)`);
}
ensureAdminAccount();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieSession({
  name: 'vickydore_session',
  keys: [process.env.SESSION_SECRET || 'dev-secret-changez-moi'],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 jours
}));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Middlewares d'authentification
// ============================================================
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Vous devez être connecté.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé à l\'administration.' });
  }
  next();
}

// ---------- Upload d'image pour la bannière publicitaire ----------
const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const promoUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `promo-banner-${Date.now()}${ext}`);
  },
});
const promoUpload = multer({
  storage: promoUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo maximum
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format non supporté. Utilisez une image JPG, PNG, WEBP ou GIF.'));
    }
    cb(null, true);
  },
});

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

// ============================================================
// AUTHENTIFICATION
// ============================================================

// Inscription cliente
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, birthDate, city } = req.body;
    if (!name || !email || !password || !birthDate || !city) return res.status(400).json({ error: 'Champs manquants.' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });

    const normalizedEmail = email.trim().toLowerCase();

    // Vérification de la liste noire : un email bloqué reste bloqué définitivement,
    // même si une date de naissance valide est fournie lors d'une nouvelle tentative.
    const blocked = db.prepare('SELECT id FROM blocked_emails WHERE email = ?').get(normalizedEmail);
    if (blocked) {
      return res.status(403).json({ error: 'Cette adresse courriel ne peut pas créer de compte.' });
    }

    // Validation de la date de naissance et de l'âge minimum (18 ans)
    const birth = new Date(birthDate);
    if (Number.isNaN(birth.getTime())) {
      return res.status(400).json({ error: 'Date de naissance invalide.' });
    }
    const today = new Date();
    if (birth > today) {
      return res.status(400).json({ error: 'Date de naissance invalide.' });
    }
    let age = today.getFullYear() - birth.getFullYear();
    const hasNotHadBirthdayThisYear =
      today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
    if (hasNotHadBirthdayThisYear) age--;

    if (age < 18) {
      // L'email est bloqué définitivement et Vicky est avertie par courriel.
      try {
        db.prepare('INSERT OR IGNORE INTO blocked_emails (email, reason) VALUES (?, ?)')
          .run(normalizedEmail, 'age_minimum_non_respecte');
      } catch (blockErr) {
        console.error('Erreur lors du blocage de l\'email :', blockErr.message);
      }
      try {
        await sendUnderageAttemptAlert({ email: normalizedEmail, name: name.trim(), birthDate });
      } catch (mailErr) {
        console.error('Erreur lors de l\'envoi de l\'alerte âge minimum :', mailErr.message);
      }
      return res.status(403).json({ error: 'Vous devez avoir au moins 18 ans pour créer un compte.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec ce courriel.' });

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`INSERT INTO users (name, email, password_hash, birth_date, city, role) VALUES (?, ?, ?, ?, ?, 'client')`)
      .run(name.trim(), normalizedEmail, hash, birthDate, city.trim());

    const user = { id: result.lastInsertRowid, name: name.trim(), email: normalizedEmail, role: 'client' };
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ user });
  } catch (err) {
    console.error('Erreur register :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription.' });
  }
});

// ============================================================
// Mot de passe oublié — demande de réinitialisation
// ============================================================
// Vérifie que l'email ET la date de naissance correspondent à un même compte
// (évite d'envoyer un lien suite à une simple faute de frappe sur un email
// qui appartiendrait à quelqu'un d'autre, et limite les doublons de demandes).
app.post('/api/auth/forgot-password', async (req, res) => {
  // Message volontairement identique dans tous les cas de "non trouvé", pour
  // ne jamais révéler si un email existe ou non dans la base.
  const genericResponse = {
    message: 'Si ces informations correspondent à un compte existant, un courriel contenant un lien de réinitialisation vient de vous être envoyé.',
  };
  try {
    const { email, birthDate } = req.body;
    if (!email || !birthDate) return res.status(400).json({ error: 'Champs manquants.' });

    const normalizedEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND birth_date = ?').get(normalizedEmail, birthDate);

    if (!user) {
      // On répond comme si tout allait bien, sans dire si l'email existe ou si c'est la date qui ne correspond pas.
      return res.json(genericResponse);
    }

    // Invalide les anciens jetons non utilisés pour ce compte, pour éviter
    // d'accumuler des liens valides en doublon.
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // valide 1 heure

    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(user.id, tokenHash, expiresAt);

    try {
      await sendPasswordResetEmail({ name: user.name, email: user.email, rawToken });
    } catch (mailErr) {
      console.error('Erreur lors de l\'envoi du courriel de réinitialisation :', mailErr.message);
    }

    res.json(genericResponse);
  } catch (err) {
    console.error('Erreur forgot-password :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Confirmation de la réinitialisation : vérifie le jeton et met à jour le mot de passe
app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Champs manquants.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRow = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash);

    if (!resetRow || resetRow.used === 1) {
      return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a déjà été utilisé.' });
    }
    if (new Date(resetRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce lien de réinitialisation a expiré. Veuillez en demander un nouveau.' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, resetRow.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(resetRow.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur reset-password :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Connexion
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

// Déconnexion
app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Qui suis-je ?
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.json({ user: null });
  res.json({ user: publicUser(row) });
});

// ============================================================
// RÉSERVATIONS (côté cliente connectée)
// ============================================================

app.post('/api/bookings', requireAuth, async (req, res) => {
  try {
    const { serviceId, bookingDate, bookingDateLabel, bookingTime } = req.body;
    const serviceRow = getServiceById(serviceId);
    if (!serviceRow || !serviceRow.active) return res.status(400).json({ error: 'Service invalide.' });
    if (!bookingDate || !bookingTime) return res.status(400).json({ error: 'Date ou heure manquante.' });

    // Le prix et le nom du service sont figés au moment de la réservation :
    // toute modification ultérieure du catalogue par l'admin n'affecte pas
    // les réservations déjà enregistrées.
    const service = publicService(serviceRow);

    // Empêche deux clientes de réserver le même créneau
    const conflict = db.prepare(`
      SELECT id FROM bookings WHERE booking_date = ? AND booking_time = ? AND status != 'annule'
    `).get(bookingDate, bookingTime);
    if (conflict) return res.status(409).json({ error: 'Ce créneau vient d\'être réservé par quelqu\'un d\'autre. Choisissez-en un autre.' });

    // Seul le virement Interac est proposé : la réservation reste toujours
    // en attente jusqu'à confirmation manuelle de Vicky dans l'espace admin,
    // une fois le virement reçu.
    const paymentMethod = 'interac';
    const status = 'en_attente';

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
      console.error('⚠️  Erreur envoi email (réservation tout de même enregistrée) :', emailErr.message);
    }

    res.json({ success: true, bookingId: result.lastInsertRowid, status });
  } catch (err) {
    console.error('Erreur création réservation :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la réservation.' });
  }
});

// Liste des réservations de la cliente connectée
app.get('/api/bookings/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY booking_date DESC, booking_time DESC')
    .all(req.session.userId);
  res.json(rows);
});

// Annuler une réservation (seulement la sienne, et seulement si future)
app.post('/api/bookings/:id/cancel', requireAuth, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });
  if (booking.user_id !== req.session.userId) return res.status(403).json({ error: 'Cette réservation ne vous appartient pas.' });

  db.prepare(`UPDATE bookings SET status = 'annule' WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// DISPONIBILITÉS (heures d'ouverture + blocages admin + réservations)
// ============================================================

// Convertit "HH:MM" en minutes depuis minuit, pour comparer facilement des plages.
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function getBusinessHoursForWeekday(weekday) {
  return db.prepare('SELECT * FROM business_hours WHERE weekday = ?').get(weekday);
}

function getBlockedPeriodsForDate(dateStr) {
  return db.prepare('SELECT * FROM blocked_periods WHERE blocked_date = ?').all(dateStr);
}

// Calcule la liste des créneaux disponibles pour une date donnée (AAAA-MM-JJ),
// en combinant : heures d'ouverture par défaut du jour de la semaine,
// blocages ponctuels créés par Vicky (jour complet ou plage précise),
// et réservations déjà existantes (statut différent de "annulé").
function computeAvailableSlots(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return [];
  const weekday = date.getDay();

  const hours = getBusinessHoursForWeekday(weekday);
  if (!hours || !hours.is_open) return [];

  const blocks = getBlockedPeriodsForDate(dateStr);
  // Un blocage sans heure de début/fin = jour complet fermé.
  if (blocks.some(b => !b.start_time || !b.end_time)) return [];

  const taken = db.prepare(`
    SELECT booking_time FROM bookings WHERE booking_date = ? AND status != 'annule'
  `).all(dateStr).map(r => r.booking_time);

  const duration = hours.slot_duration_minutes || 30;
  const gap = hours.break_between_slots_minutes || 0;
  const step = duration + gap; // espacement fixe entre le début de chaque créneau
  const slots = [];
  for (let t = timeToMinutes(hours.start_time); t + duration <= timeToMinutes(hours.end_time); t += step) {
    const slotLabel = minutesToTime(t);
    const slotEnd = t + duration;

    // Exclu si dans la pause déjeuner habituelle (s'il y en a une).
    if (hours.break_start && hours.break_end) {
      const breakStart = timeToMinutes(hours.break_start);
      const breakEnd = timeToMinutes(hours.break_end);
      if (t < breakEnd && slotEnd > breakStart) continue;
    }

    // Exclu si dans une plage bloquée ponctuelle.
    const isBlocked = blocks.some(b => {
      const bStart = timeToMinutes(b.start_time);
      const bEnd = timeToMinutes(b.end_time);
      return t < bEnd && slotEnd > bStart;
    });
    if (isBlocked) continue;

    // Exclu si déjà réservé.
    if (taken.includes(slotLabel)) continue;

    slots.push(slotLabel);
  }
  return slots;
}

// Route publique (lecture seule) : permet au calendrier client de savoir
// quels jours de la semaine sont ouverts, pour griser les jours fermés
// sans avoir à interroger /api/availability pour chaque jour affiché.
app.get('/api/business-hours', (req, res) => {
  const rows = db.prepare('SELECT * FROM business_hours ORDER BY weekday ASC').all();
  res.json(rows.map(r => ({
    weekday: r.weekday,
    isOpen: !!r.is_open,
    startTime: r.start_time,
    endTime: r.end_time,
  })));
});

// Route publique : utilisée par l'étape "calendrier" de la réservation.
// Remplace l'ancienne génération de créneaux codée en dur côté client.
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Paramètre date manquant.' });
  res.json({ date, slots: computeAvailableSlots(date) });
});
// Conservée pour compatibilité : créneaux déjà pris pour une date donnée.
// La nouvelle route /api/availability est désormais la source recommandée
// côté client, car elle tient aussi compte des heures d'ouverture et des
// blocages admin, pas seulement des réservations existantes.
app.get('/api/bookings/taken', (req, res) => {
  const { date } = req.query; // format AAAA-MM-JJ
  if (!date) return res.status(400).json({ error: 'Paramètre date manquant.' });
  const rows = db.prepare(`SELECT booking_time FROM bookings WHERE booking_date = ? AND status != 'annule'`).all(date);
  res.json({ takenTimes: rows.map(r => r.booking_time) });
});

// ============================================================
// SERVICES (catalogue public — lu par le site pour afficher les services)
// ============================================================

app.get('/api/services', (req, res) => {
  const rows = getActiveServices();
  res.json(rows.map(publicService));
});

// ============================================================
// ESPACE ADMIN (Vicky voit tout)
// ============================================================

// ---------- Flux calendrier (abonnement webcal pour l'iPhone de Vicky) ----------
// Le token est dérivé de SESSION_SECRET par HMAC : stable entre les redémarrages,
// jamais stocké en clair, et impossible à deviner sans connaître le secret du serveur.
function getCalendarToken() {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'fallback-secret-a-remplacer')
    .update('vicky-dore-calendar-feed')
    .digest('hex')
    .slice(0, 32);
}

// Convertit une durée stockée en texte libre (ex: "30 min", "1h30") en minutes.
// Détermine si une date donnée est en heure avancée de l'Est (DST) pour Montréal.
// Règle nord-américaine : du 2e dimanche de mars (2h00) au 1er dimanche de novembre (2h00).
function isMontrealDST(year, month, day) {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;

  // Trouve le n-ième dimanche d'un mois donné.
  function nthSunday(y, m, n) {
    const first = new Date(Date.UTC(y, m - 1, 1));
    const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
    return firstSunday + (n - 1) * 7;
  }

  if (month === 3) return day >= nthSunday(year, 3, 2);
  if (month === 11) return day < nthSunday(year, 11, 1);
  return false;
}

function parseDurationToMinutes(durationText) {
  if (!durationText) return 60;
  const text = durationText.toLowerCase();
  const hMatch = text.match(/(\d+)\s*h/);
  const minMatch = text.match(/(\d+)\s*min/);
  let total = 0;
  if (hMatch) total += parseInt(hMatch[1], 10) * 60;
  if (minMatch) total += parseInt(minMatch[1], 10);
  return total > 0 ? total : 60;
}

// Échappe les caractères spéciaux requis par la norme iCalendar (RFC 5545).
function icsEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Formate une date JS en UTC au format iCalendar : AAAAMMJJTHHMMSSZ
function toIcsDateUTC(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function generateBookingsIcs(bookings) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vicky Dore - Guidance et Eveil//Reservations//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Rendez-vous - Vicky Doré',
    'X-WR-TIMEZONE:America/Toronto',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  bookings.forEach(b => {
    // booking_date = AAAA-MM-JJ, booking_time = HH:MM — interprétés en heure de Montréal.
    const [year, month, day] = b.booking_date.split('-').map(Number);
    const [hour, minute] = b.booking_time.split(':').map(Number);

    // DST (heure avancée de l'Est) : du 2e dimanche de mars au 1er dimanche de novembre.
    const isDST = isMontrealDST(year, month, day);
    const utcOffsetHours = isDST ? 4 : 5;

    const startUTC = new Date(Date.UTC(year, month - 1, day, hour + utcOffsetHours, minute));
    const durationMin = parseDurationToMinutes(b.service_duration);
    const endUTC = new Date(startUTC.getTime() + durationMin * 60000);

    lines.push(
      'BEGIN:VEVENT',
      `UID:booking-${b.id}@vickydore.com`,
      `DTSTAMP:${toIcsDateUTC(new Date())}`,
      `DTSTART:${toIcsDateUTC(startUTC)}`,
      `DTEND:${toIcsDateUTC(endUTC)}`,
      `SUMMARY:${icsEscape(b.service_name + ' — ' + b.client_name)}`,
      `DESCRIPTION:${icsEscape(
        'Cliente : ' + b.client_name + '\\n' +
        'Courriel : ' + b.client_email + '\\n' +
        'Service : ' + b.service_name + '\\n' +
        'Prix : ' + (b.service_price_cents / 100).toFixed(2) + ' $\\n' +
        'Paiement : ' + (b.payment_method === 'carte' ? 'Carte' : 'Interac')
      )}`,
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT bookings.*, users.name as client_name, users.email as client_email
    FROM bookings
    JOIN users ON users.id = bookings.user_id
    ORDER BY booking_date DESC, booking_time DESC
  `).all();
  res.json(rows);
});

app.get('/api/admin/clients', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, name, email, created_at FROM users WHERE role = 'client' ORDER BY created_at DESC`).all();
  res.json(rows);
});

// Renvoie l'URL d'abonnement (avec le token secret) à afficher dans le panneau admin.
// Protégée par requireAdmin : seule Vicky connectée peut voir/copier ce lien.
app.get('/api/admin/calendar-feed-url', requireAdmin, (req, res) => {
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const token = getCalendarToken();
  const httpsUrl = `${siteUrl.replace(/\/$/, '')}/api/calendar/${token}/rendez-vous.ics`;
  // webcal:// déclenche l'ouverture directe dans l'app Calendrier sur iPhone.
  const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
  res.json({ httpsUrl, webcalUrl });
});

// Flux iCalendar public (lecture seule), protégé uniquement par le token dans l'URL —
// volontairement SANS requireAdmin, car l'app Calendrier de l'iPhone ne peut pas
// envoyer de cookie de session lorsqu'elle vient rafraîchir l'abonnement.
app.get('/api/calendar/:token/rendez-vous.ics', (req, res) => {
  if (req.params.token !== getCalendarToken()) {
    return res.status(403).send('Accès refusé.');
  }

  const bookings = db.prepare(`
    SELECT bookings.*, users.name as client_name, users.email as client_email,
           services.duration as service_duration
    FROM bookings
    JOIN users ON users.id = bookings.user_id
    LEFT JOIN services ON services.name = bookings.service_name
    WHERE bookings.status = 'confirme'
    ORDER BY booking_date ASC, booking_time ASC
  `).all();

  const ics = generateBookingsIcs(bookings);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="rendez-vous-vicky-dore.ics"');
  res.send(ics);
});

// Supprime définitivement tous les rendez-vous dont la date est déjà passée.
// Route déclarée AVANT /api/admin/bookings/:id/status pour éviter tout conflit de routage.
app.delete('/api/admin/bookings/history', requireAdmin, (req, res) => {
  const result = db.prepare(`
    DELETE FROM bookings WHERE booking_date < date('now')
  `).run();

  res.json({ success: true, deletedCount: result.changes });
});

app.post('/api/admin/bookings/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['en_attente', 'confirme', 'annule'].includes(status)) return res.status(400).json({ error: 'Statut invalide.' });

  // On récupère la réservation + les infos du client AVANT la mise à jour,
  // afin de pouvoir lui envoyer un courriel reflétant le nouveau statut.
  const booking = db.prepare(`
    SELECT bookings.*, users.name as client_name, users.email as client_email
    FROM bookings JOIN users ON users.id = bookings.user_id
    WHERE bookings.id = ?
  `).get(req.params.id);

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable.' });

  db.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).run(status, req.params.id);

  // Le courriel ne doit jamais empêcher la mise à jour du statut en cas d'échec d'envoi.
  try {
    await sendConfirmationEmails({
      clientName: booking.client_name,
      clientEmail: booking.client_email,
      service: { name: booking.service_name, price: formatPriceLabel(booking.service_price_cents) },
      bookingDateLabel: booking.booking_date_label,
      bookingTime: booking.booking_time,
      paymentMethod: booking.payment_method,
      status,
      notifyAdmin: false,
    });
  } catch (emailErr) {
    console.error('⚠️  Erreur envoi courriel de changement de statut :', emailErr.message);
  }

  res.json({ success: true });
});

// ---------- Gestion du catalogue des services (prix + description) ----------

// Liste complète (y compris services désactivés, s'il y en a) pour l'admin
app.get('/api/admin/services', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM services ORDER BY sort_order ASC, id ASC').all();
  res.json(rows.map(publicService));
});

// Mise à jour du prix et/ou de la description d'un service.
// Important : ceci ne modifie QUE le catalogue affiché pour les futures
// réservations. Les réservations déjà enregistrées gardent en mémoire le
// nom et le prix tels qu'ils étaient au moment de la réservation
// (colonnes service_name / service_price_cents de la table bookings),
// donc rien ne change rétroactivement pour les rendez-vous déjà pris.
app.put('/api/admin/services/:id', requireAdmin, (req, res) => {
  try {
    const existing = getServiceById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Service introuvable.' });

    const { name, duration, description, price } = req.body;

    let priceCents = existing.price_cents;
    if (price !== undefined && price !== null && price !== '') {
      const normalized = String(price).replace(',', '.').replace(/[^0-9.]/g, '');
      const parsed = Math.round(parseFloat(normalized) * 100);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'Prix invalide.' });
      }
      priceCents = parsed;
    }

    const newName = (name !== undefined && name !== null && name.trim() !== '') ? name.trim() : existing.name;
    const newDuration = (duration !== undefined && duration !== null && duration.trim() !== '') ? duration.trim() : existing.duration;
    const newDescription = (description !== undefined && description !== null) ? description.trim() : existing.description;

    db.prepare(`
      UPDATE services SET name = ?, duration = ?, description = ?, price_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newName, newDuration, newDescription, priceCents, req.params.id);

    const updated = getServiceById(req.params.id);
    res.json({ success: true, service: publicService(updated) });
  } catch (err) {
    console.error('Erreur mise à jour service :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la mise à jour du service.' });
  }
});

// Création d'un nouveau service dans le catalogue.
// Limité à MAX_ACTIVE_SERVICES services actifs en même temps : Vicky doit
// d'abord désactiver un service existant si elle a déjà atteint la limite.
app.post('/api/admin/services', requireAdmin, (req, res) => {
  try {
    const { name, duration, description, price } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Le nom du service est requis.' });
    }
    if (!duration || !String(duration).trim()) {
      return res.status(400).json({ error: 'La durée du service est requise.' });
    }

    const normalizedPrice = String(price ?? '').replace(',', '.').replace(/[^0-9.]/g, '');
    const priceCents = Math.round(parseFloat(normalizedPrice) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return res.status(400).json({ error: 'Prix invalide.' });
    }

    const activeCount = db.prepare('SELECT COUNT(*) as n FROM services WHERE active = 1').get().n;
    if (activeCount >= MAX_ACTIVE_SERVICES) {
      return res.status(400).json({
        error: `Limite atteinte : ${MAX_ACTIVE_SERVICES} services actifs maximum. Désactivez-en un avant d'en ajouter un nouveau.`,
      });
    }

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM services').get().m;

    const result = db.prepare(`
      INSERT INTO services (sort_order, name, duration, description, price_cents, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(maxOrder + 1, String(name).trim(), String(duration).trim(), description ? String(description).trim() : '', priceCents);

    const created = getServiceById(result.lastInsertRowid);
    res.json({ success: true, service: publicService(created) });
  } catch (err) {
    console.error('Erreur création service :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la création du service.' });
  }
});

// Désactivation (« suppression douce ») d'un service.
// Le service disparaît du site et des nouvelles réservations possibles,
// mais reste en base pour ne pas casser l'historique des réservations
// déjà prises (qui référencent le nom/prix au moment de la réservation).
app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
  try {
    const existing = getServiceById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Service introuvable.' });

    db.prepare(`UPDATE services SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur désactivation service :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la désactivation du service.' });
  }
});

// Réactivation d'un service précédemment désactivé (utile si Vicky change
// d'avis), tant que la limite de services actifs n'est pas dépassée.
app.post('/api/admin/services/:id/reactivate', requireAdmin, (req, res) => {
  try {
    const existing = getServiceById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Service introuvable.' });

    const activeCount = db.prepare('SELECT COUNT(*) as n FROM services WHERE active = 1').get().n;
    if (activeCount >= MAX_ACTIVE_SERVICES) {
      return res.status(400).json({
        error: `Limite atteinte : ${MAX_ACTIVE_SERVICES} services actifs maximum. Désactivez-en un avant de réactiver celui-ci.`,
      });
    }

    db.prepare(`UPDATE services SET active = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = getServiceById(req.params.id);
    res.json({ success: true, service: publicService(updated) });
  } catch (err) {
    console.error('Erreur réactivation service :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la réactivation du service.' });
  }
});

// ============================================================
// TÉMOIGNAGES — soumission par les clientes + modération admin
// ============================================================

// Liste publique : uniquement les témoignages approuvés par Vicky,
// les plus récents en premier.
app.get('/api/testimonials', (req, res) => {
  const rows = db.prepare(`
    SELECT testimonials.id, testimonials.rating, testimonials.quote, testimonials.created_at, users.name as author_name
    FROM testimonials JOIN users ON users.id = testimonials.user_id
    WHERE testimonials.status = 'approuve'
    ORDER BY testimonials.created_at DESC
  `).all();
  res.json(rows);
});

// Soumission d'un témoignage par une cliente connectée.
// Le témoignage part toujours en statut "en_attente" : il ne sera visible
// publiquement qu'une fois approuvé par Vicky depuis l'espace admin.
app.post('/api/testimonials', requireAuth, async (req, res) => {
  try {
    const { rating, quote } = req.body;

    const parsedRating = Number(rating);
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ error: 'La note doit être un nombre entier entre 1 et 5.' });
    }
    if (!quote || !String(quote).trim()) {
      return res.status(400).json({ error: 'Le témoignage ne peut pas être vide.' });
    }
    const trimmedQuote = String(quote).trim();
    if (trimmedQuote.length > 1000) {
      return res.status(400).json({ error: 'Le témoignage est trop long (1000 caractères maximum).' });
    }

    const result = db.prepare(`
      INSERT INTO testimonials (user_id, rating, quote, status) VALUES (?, ?, ?, 'en_attente')
    `).run(req.session.userId, parsedRating, trimmedQuote);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

    // Le témoignage est tout de même enregistré même si le courriel échoue.
    try {
      await sendNewTestimonialAlert({
        clientName: user.name,
        clientEmail: user.email,
        rating: parsedRating,
        quote: trimmedQuote,
      });
    } catch (mailErr) {
      console.error('⚠️  Erreur envoi alerte nouveau témoignage :', mailErr.message);
    }

    res.json({ success: true, testimonialId: result.lastInsertRowid });
  } catch (err) {
    console.error('Erreur création témoignage :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'envoi du témoignage.' });
  }
});

// Liste complète pour l'admin (tous statuts), pour la modération.
app.get('/api/admin/testimonials', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT testimonials.*, users.name as author_name, users.email as author_email
    FROM testimonials JOIN users ON users.id = testimonials.user_id
    ORDER BY
      CASE testimonials.status WHEN 'en_attente' THEN 0 ELSE 1 END,
      testimonials.created_at DESC
  `).all();
  res.json(rows);
});

// Approbation ou rejet d'un témoignage par Vicky.
app.post('/api/admin/testimonials/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['approuve', 'rejete', 'en_attente'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }
  const existing = db.prepare('SELECT id FROM testimonials WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Témoignage introuvable.' });

  db.prepare(`UPDATE testimonials SET status = ?, reviewed_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  res.json({ success: true });
});

// Suppression définitive d'un témoignage (ex. contenu inapproprié).
app.delete('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// FIL DE CONVERSATION — réservé aux clientes connectées (compte requis)
// ============================================================

// Récupère (ou crée) la conversation de la cliente connectée et tous ses messages.
app.get('/api/conversation', requireAuth, (req, res) => {
  let conversation = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(req.session.userId);
  if (!conversation) {
    return res.json({ conversation: null, messages: [] });
  }

  const messages = db.prepare(`
    SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversation.id);

  // La cliente vient de consulter : on retire son indicateur "non lu".
  db.prepare('UPDATE conversations SET has_unread_for_client = 0 WHERE id = ?').run(conversation.id);

  res.json({ conversation, messages });
});

// Envoi d'un message par la cliente (premier message ou suite de conversation).
app.post('/api/conversation', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
    }
    const trimmedMessage = String(message).trim().slice(0, 5000);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

    let conversation = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(req.session.userId);
    if (!conversation) {
      const result = db.prepare(`
        INSERT INTO conversations (user_id, has_unread_for_admin, has_unread_for_client) VALUES (?, 1, 0)
      `).run(req.session.userId);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    } else {
      db.prepare(`
        UPDATE conversations SET has_unread_for_admin = 1, updated_at = datetime('now') WHERE id = ?
      `).run(conversation.id);
    }

    const msgResult = db.prepare(`
      INSERT INTO conversation_messages (conversation_id, sender, message, email_sent) VALUES (?, 'client', ?, 0)
    `).run(conversation.id, trimmedMessage);

    let emailSent = false;
    try {
      await sendConversationAlertToAdmin({ clientName: user.name, clientEmail: user.email, message: trimmedMessage });
      emailSent = true;
    } catch (mailErr) {
      console.error('⚠️  Erreur envoi courriel (nouveau message client, message tout de même enregistré) :', mailErr.message);
    }
    if (emailSent) {
      db.prepare('UPDATE conversation_messages SET email_sent = 1 WHERE id = ?').run(msgResult.lastInsertRowid);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur traitement message de conversation :', err.message);
    res.status(500).json({ error: 'Erreur lors de l\'envoi du message. Veuillez réessayer ou écrire directement à message_VD@hotmail.com.' });
  }
});

// ============================================================
// ADMIN — gestion des conversations
// ============================================================

// Liste des conversations, les non lues par l'admin en premier, puis les plus récentes.
app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT conversations.*, users.name as client_name, users.email as client_email,
      (SELECT message FROM conversation_messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT sender FROM conversation_messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) as last_sender
    FROM conversations
    JOIN users ON users.id = conversations.user_id
    ORDER BY conversations.has_unread_for_admin DESC, conversations.updated_at DESC
  `).all();
  res.json(rows);
});

// Détail d'une conversation (tous les messages), avec marquage "lu" pour l'admin.
app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const conversation = db.prepare(`
    SELECT conversations.*, users.name as client_name, users.email as client_email
    FROM conversations JOIN users ON users.id = conversations.user_id
    WHERE conversations.id = ?
  `).get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation introuvable.' });

  const messages = db.prepare(`
    SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversation.id);

  db.prepare('UPDATE conversations SET has_unread_for_admin = 0 WHERE id = ?').run(conversation.id);

  res.json({ conversation, messages });
});

// Réponse de Vicky dans une conversation.
app.post('/api/admin/conversations/:id/reply', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
    }
    const trimmedMessage = String(message).trim().slice(0, 5000);

    const conversation = db.prepare(`
      SELECT conversations.*, users.name as client_name, users.email as client_email
      FROM conversations JOIN users ON users.id = conversations.user_id
      WHERE conversations.id = ?
    `).get(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation introuvable.' });

    const msgResult = db.prepare(`
      INSERT INTO conversation_messages (conversation_id, sender, message, email_sent) VALUES (?, 'admin', ?, 0)
    `).run(conversation.id, trimmedMessage);

    db.prepare(`
      UPDATE conversations SET has_unread_for_client = 1, updated_at = datetime('now') WHERE id = ?
    `).run(conversation.id);

    let emailSent = false;
    try {
      await sendConversationReplyToClient({ clientName: conversation.client_name, clientEmail: conversation.client_email, message: trimmedMessage });
      emailSent = true;
    } catch (mailErr) {
      console.error('⚠️  Erreur envoi courriel (réponse de Vicky, message tout de même enregistré) :', mailErr.message);
    }
    if (emailSent) {
      db.prepare('UPDATE conversation_messages SET email_sent = 1 WHERE id = ?').run(msgResult.lastInsertRowid);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur traitement réponse admin :', err.message);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de la réponse.' });
  }
});

// Suppression d'une conversation entière (et tous ses messages).
app.delete('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(req.params.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// DISPONIBILITÉS — gestion admin (heures d'ouverture + blocages)
// ============================================================

// Liste des 7 jours avec leurs heures d'ouverture actuelles.
app.get('/api/admin/business-hours', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM business_hours ORDER BY weekday ASC').all();
  res.json(rows);
});

// Met à jour les heures d'un jour de la semaine (0 = dimanche ... 6 = samedi).
app.put('/api/admin/business-hours/:weekday', requireAdmin, (req, res) => {
  try {
    const weekday = parseInt(req.params.weekday, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return res.status(400).json({ error: 'Jour de la semaine invalide.' });
    }
    const existing = getBusinessHoursForWeekday(weekday);
    if (!existing) return res.status(404).json({ error: 'Jour introuvable.' });

    const { isOpen, startTime, endTime, slotDurationMinutes, breakBetweenSlotsMinutes, breakStart, breakEnd } = req.body;

    const newIsOpen = (isOpen !== undefined) ? (isOpen ? 1 : 0) : existing.is_open;
    const newStart = startTime || existing.start_time;
    const newEnd = endTime || existing.end_time;
    const newDuration = slotDurationMinutes ? parseInt(slotDurationMinutes, 10) : existing.slot_duration_minutes;

    const ALLOWED_GAPS = [0, 30, 60, 90];
    let newGap = existing.break_between_slots_minutes;
    if (breakBetweenSlotsMinutes !== undefined) {
      const parsedGap = parseInt(breakBetweenSlotsMinutes, 10);
      if (!ALLOWED_GAPS.includes(parsedGap)) {
        return res.status(400).json({ error: 'Pause entre les créneaux invalide (0, 30, 60 ou 90 minutes).' });
      }
      newGap = parsedGap;
    }

    if (timeToMinutes(newStart) >= timeToMinutes(newEnd)) {
      return res.status(400).json({ error: 'L\'heure de début doit précéder l\'heure de fin.' });
    }

    // breakStart/breakEnd : chaîne vide ou null = pas de pause.
    const newBreakStart = (breakStart !== undefined) ? (breakStart || null) : existing.break_start;
    const newBreakEnd = (breakEnd !== undefined) ? (breakEnd || null) : existing.break_end;
    if ((newBreakStart && !newBreakEnd) || (!newBreakStart && newBreakEnd)) {
      return res.status(400).json({ error: 'La pause doit avoir une heure de début ET de fin.' });
    }

    db.prepare(`
      UPDATE business_hours
      SET is_open = ?, start_time = ?, end_time = ?, slot_duration_minutes = ?,
          break_between_slots_minutes = ?, break_start = ?, break_end = ?, updated_at = datetime('now')
      WHERE weekday = ?
    `).run(newIsOpen, newStart, newEnd, newDuration, newGap, newBreakStart, newBreakEnd, weekday);

    res.json({ success: true, businessHours: getBusinessHoursForWeekday(weekday) });
  } catch (err) {
    console.error('Erreur mise à jour heures d\'ouverture :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Liste des blocages à venir (vacances, fermetures, plages bloquées).
app.get('/api/admin/blocked-periods', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM blocked_periods WHERE blocked_date >= date('now') ORDER BY blocked_date ASC, start_time ASC
  `).all();
  res.json(rows);
});

// Crée un blocage : jour complet (startTime/endTime omis) ou plage précise.
app.post('/api/admin/blocked-periods', requireAdmin, (req, res) => {
  try {
    const { blockedDate, startTime, endTime, reason } = req.body;
    if (!blockedDate) return res.status(400).json({ error: 'Date manquante.' });

    if ((startTime && !endTime) || (!startTime && endTime)) {
      return res.status(400).json({ error: 'Indiquez une heure de début ET de fin, ou laissez les deux vides pour bloquer la journée complète.' });
    }
    if (startTime && endTime && timeToMinutes(startTime) >= timeToMinutes(endTime)) {
      return res.status(400).json({ error: 'L\'heure de début doit précéder l\'heure de fin.' });
    }

    const result = db.prepare(`
      INSERT INTO blocked_periods (blocked_date, start_time, end_time, reason)
      VALUES (?, ?, ?, ?)
    `).run(blockedDate, startTime || null, endTime || null, (reason || '').trim());

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Erreur création blocage :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Supprime un blocage (Vicky change d'avis / erreur de saisie).
app.delete('/api/admin/blocked-periods/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blocked_periods WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});



// Accessible à tout le monde : la page d'accueil affiche la bannière si elle existe.
app.get('/api/promo-banner', (req, res) => {
  const row = db.prepare('SELECT * FROM promo_banner WHERE id = 1').get();
  if (!row) return res.json({ active: false, imagePath: null, linkUrl: null });
  res.json({
    active: Boolean(row.active) && Boolean(row.image_path),
    imagePath: row.image_path,
    linkUrl: row.link_url,
  });
});

// Admin seulement : téléverse une nouvelle image pour la bannière.
// L'ancienne image (si elle existe) est supprimée du disque pour ne pas accumuler de fichiers inutiles.
app.post('/api/admin/promo-banner/image', requireAdmin, (req, res) => {
  promoUpload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Erreur lors du téléversement.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Aucune image reçue.' });
    }
    try {
      const previous = db.prepare('SELECT image_path FROM promo_banner WHERE id = 1').get();
      const newPath = `/uploads/${req.file.filename}`;

      db.prepare(`
        UPDATE promo_banner SET image_path = ?, active = 1, updated_at = datetime('now') WHERE id = 1
      `).run(newPath);

      if (previous && previous.image_path) {
        const oldFile = path.join(__dirname, 'public', previous.image_path.replace(/^\//, ''));
        fs.unlink(oldFile, () => {}); // suppression silencieuse, sans bloquer la réponse
      }

      res.json({ success: true, imagePath: newPath });
    } catch (dbErr) {
      console.error('Erreur enregistrement bannière promo :', dbErr.message);
      res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement.' });
    }
  });
});

// Admin seulement : met à jour le lien de destination et/ou active ou désactive la bannière,
// sans nécessiter un nouveau téléversement d'image.
app.put('/api/admin/promo-banner', requireAdmin, (req, res) => {
  try {
    const { linkUrl, active } = req.body;
    const current = db.prepare('SELECT * FROM promo_banner WHERE id = 1').get();

    const newLink = (linkUrl !== undefined && linkUrl !== null && linkUrl.trim() !== '')
      ? linkUrl.trim()
      : current.link_url;
    const newActive = (active !== undefined) ? (active ? 1 : 0) : current.active;

    db.prepare(`
      UPDATE promo_banner SET link_url = ?, active = ?, updated_at = datetime('now') WHERE id = 1
    `).run(newLink, newActive);

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur mise à jour bannière promo :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Admin seulement : retire complètement l'image actuelle (la bannière redevient masquée).
app.delete('/api/admin/promo-banner/image', requireAdmin, (req, res) => {
  try {
    const current = db.prepare('SELECT image_path FROM promo_banner WHERE id = 1').get();
    if (current && current.image_path) {
      const oldFile = path.join(__dirname, 'public', current.image_path.replace(/^\//, ''));
      fs.unlink(oldFile, () => {});
    }
    db.prepare(`UPDATE promo_banner SET image_path = NULL, active = 0, updated_at = datetime('now') WHERE id = 1`).run();
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur suppression bannière promo :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ============================================================
// Envoi des emails de confirmation via Resend
// ============================================================
async function sendConfirmationEmails({ clientName, clientEmail, service, bookingDateLabel, bookingTime, paymentMethod, status, notifyAdmin = true }) {
  const methodLabel = paymentMethod === 'carte' ? 'Carte bancaire' : 'Virement Interac';
  const statusLabel = status === 'confirme'
    ? 'Confirmée'
    : status === 'annule'
      ? 'Annulée'
      : 'En attente de paiement';

  let clientBodyHtml;
  if (status === 'confirme') {
    clientBodyHtml = `
      <p>Bonne nouvelle ${escapeHtml(clientName)}, votre rendez-vous est confirmé ! ✦</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#8A7A74;">Service</td><td style="padding:6px 0;text-align:right;">${escapeHtml(service.name)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Date</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingDateLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Heure</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingTime)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Paiement</td><td style="padding:6px 0;text-align:right;">${methodLabel}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;font-weight:bold;">Total</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${service.price}</td></tr>
      </table>
      <p>Vous pouvez consulter ou annuler ce rendez-vous depuis votre profil sur le site.</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    `;
  } else if (status === 'annule') {
    clientBodyHtml = `
      <p>Bonjour ${escapeHtml(clientName)},</p>
      <p>Votre rendez-vous du <strong>${escapeHtml(bookingDateLabel)}</strong> à <strong>${escapeHtml(bookingTime)}</strong> pour <strong>${escapeHtml(service.name)}</strong> a été annulé.</p>
      <p>N'hésitez pas à reprendre rendez-vous depuis le site quand vous le souhaitez.</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    `;
  } else {
    clientBodyHtml = `
      <p>Bonjour ${escapeHtml(clientName)},</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#8A7A74;">Service</td><td style="padding:6px 0;text-align:right;">${escapeHtml(service.name)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Date</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingDateLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Heure</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingTime)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Paiement</td><td style="padding:6px 0;text-align:right;">${methodLabel}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;font-weight:bold;">Total</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${service.price}</td></tr>
      </table>
      ${paymentMethod === 'interac'
        ? '<p>Merci d\'envoyer votre virement Interac à <strong>paiement.vickydore@hotmail.com</strong> pour confirmer votre rendez-vous.</p>'
        : ''}
      <p>Vous pouvez consulter ou annuler ce rendez-vous depuis votre profil sur le site.</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    `;
  }

  const clientHtml = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h2 style="color:#A87C2E;">Votre réservation — ${statusLabel} ✦</h2>
      ${clientBodyHtml}
    </div>
  `;

  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  console.log('\n📧 [DEBUG] Envoi du courriel de confirmation au client');
  console.log('📧 [DEBUG] EMAIL_FROM utilisé   :', fromAddress);
  console.log('📧 [DEBUG] Destinataire (client) :', clientEmail);

  try {
    const clientResult = await resend.emails.send({ from: fromAddress, to: clientEmail, subject: `Votre réservation — ${statusLabel} — Vicky Doré`, html: clientHtml });
    console.log('📧 [DEBUG] Réponse Resend (client) :', JSON.stringify(clientResult));
  } catch (sendErr) {
    console.error('❌ [DEBUG] Erreur Resend (client) :', sendErr);
  }

  if (notifyAdmin) {
    const adminAddress = process.env.ADMIN_EMAIL || 'message_VD@hotmail.com';
    const adminHtml = `
      <div style="font-family:Georgia,serif;color:#352B28;">
        <h3>Nouvelle réservation en attente de virement Interac</h3>
        <p><strong>${escapeHtml(clientName)}</strong> (${escapeHtml(clientEmail)})</p>
        <p>${escapeHtml(service.name)} — ${escapeHtml(bookingDateLabel)} à ${escapeHtml(bookingTime)}</p>
        <p>Montant attendu : <strong>${service.price}</strong></p>
        <p>Vérifiez la réception du virement Interac, puis confirmez (ou annulez) cette réservation depuis l'espace admin du site.</p>
      </div>
    `;
    console.log('📧 [DEBUG] Destinataire (admin)  :', adminAddress);
    try {
      const adminResult = await resend.emails.send({ from: fromAddress, to: adminAddress, subject: `Nouvelle réservation : ${service.name}`, html: adminHtml });
      console.log('📧 [DEBUG] Réponse Resend (admin) :', JSON.stringify(adminResult));
    } catch (sendErr) {
      console.error('❌ [DEBUG] Erreur Resend (admin) :', sendErr);
    }
  }
}

// ============================================================
// Courriel de rappel — envoyé 24h avant un rendez-vous confirmé
// ============================================================
async function sendReminderEmail({ clientName, clientEmail, serviceName, bookingDateLabel, bookingTime }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h2 style="color:#A87C2E;">Rappel de votre rendez-vous ✦</h2>
      <p>Bonjour ${escapeHtml(clientName)},</p>
      <p>Petit rappel : votre rendez-vous a lieu <strong>demain</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#8A7A74;">Service</td><td style="padding:6px 0;text-align:right;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Date</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingDateLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#8A7A74;">Heure</td><td style="padding:6px 0;text-align:right;">${escapeHtml(bookingTime)}</td></tr>
      </table>
      <p>Si vous devez annuler ou modifier ce rendez-vous, vous pouvez le faire depuis votre profil sur le site, dans « Mes rendez-vous ».</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: clientEmail,
    subject: 'Rappel : votre rendez-vous est demain — Vicky Doré',
    html,
  });
}

// ============================================================
// Alerte admin : tentative d'inscription avec un âge inférieur à 18 ans
// ============================================================
async function sendUnderageAttemptAlert({ email, name, birthDate }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminAddress = process.env.ADMIN_EMAIL || 'message_VD@hotmail.com';

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;">
      <h3 style="color:#B3261E;">⚠️ Tentative d'inscription refusée — âge minimum non respecté</h3>
      <p>Une tentative de création de compte a été automatiquement refusée car la personne a indiqué un âge inférieur à 18 ans.</p>
      <table style="border-collapse:collapse;margin:12px 0;">
        <tr><td style="padding:4px 12px 4px 0;color:#8A7A74;">Nom fourni</td><td style="padding:4px 0;">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A7A74;">Courriel</td><td style="padding:4px 0;">${escapeHtml(email)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8A7A74;">Date de naissance fournie</td><td style="padding:4px 0;">${escapeHtml(birthDate)}</td></tr>
      </table>
      <p>Cette adresse courriel a été bloquée automatiquement et ne pourra plus créer de compte sur le site.</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: adminAddress,
    subject: `Inscription refusée (âge) — ${email}`,
    html,
  });
}

// ============================================================
// Courriel : alerte à Vicky lors d'un nouveau témoignage à modérer
// ============================================================
async function sendNewTestimonialAlert({ clientName, clientEmail, rating, quote }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminAddress = process.env.ADMIN_EMAIL || 'message_VD@hotmail.com';

  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h3 style="color:#A87C2E;">Nouveau témoignage à approuver ✦</h3>
      <p><strong>${escapeHtml(clientName)}</strong> (${escapeHtml(clientEmail)})</p>
      <p style="color:#A87C2E;letter-spacing:2px;">${stars}</p>
      <p style="font-style:italic;border-left:3px solid #E8DCC8;padding-left:12px;">${escapeHtml(quote)}</p>
      <p>Connectez-vous à l'espace admin du site pour approuver ou rejeter ce témoignage avant qu'il ne soit visible publiquement.</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: adminAddress,
    subject: `Nouveau témoignage à modérer — ${clientName}`,
    html,
  });
}

// ============================================================
// Courriel : nouveau message d'une cliente dans le fil de conversation (vers Vicky)
// ============================================================
async function sendConversationAlertToAdmin({ clientName, clientEmail, message }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminAddress = process.env.ADMIN_EMAIL || 'message_VD@hotmail.com';

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h3 style="color:#A87C2E;">Nouveau message — ${escapeHtml(clientName)} ✦</h3>
      <p><a href="mailto:${escapeHtml(clientEmail)}" style="color:#A87C2E;">${escapeHtml(clientEmail)}</a></p>
      <p style="white-space:pre-wrap;border-left:3px solid #E8DCC8;padding-left:12px;margin-top:16px;">${escapeHtml(message)}</p>
      <p style="margin-top:20px;font-size:13px;color:#8A7A74;">Connectez-vous à l'espace admin pour répondre directement dans la conversation.</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: adminAddress,
    replyTo: clientEmail,
    subject: `Nouveau message — ${clientName}`,
    html,
  });
}

// ============================================================
// Courriel : réponse de Vicky dans le fil de conversation (vers la cliente)
// ============================================================
async function sendConversationReplyToClient({ clientName, clientEmail, message }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h3 style="color:#A87C2E;">Nouvelle réponse de Vicky ✦</h3>
      <p>Bonjour ${escapeHtml(clientName)},</p>
      <p style="white-space:pre-wrap;border-left:3px solid #E8DCC8;padding-left:12px;margin-top:16px;">${escapeHtml(message)}</p>
      <p style="margin-top:20px;font-size:13px;color:#8A7A74;">Connectez-vous à votre profil sur le site pour répondre directement dans la conversation.</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: clientEmail,
    subject: `Vicky Doré vous a répondu`,
    html,
  });
}

// ============================================================
// Courriel : lien de réinitialisation du mot de passe
// ============================================================
async function sendPasswordResetEmail({ name, email, rawToken }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  // SITE_URL doit être défini dans .env (ex: https://www.vickydore.com). En son
  // absence, on retombe sur localhost pour les tests en local.
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
  const resetLink = `${siteUrl}/?reset=${rawToken}`;

  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h2 style="color:#A87C2E;">Réinitialisation de votre mot de passe ✦</h2>
      <p>Bonjour ${escapeHtml(name)},</p>
      <p>Une demande de réinitialisation de mot de passe a été faite pour votre compte. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${resetLink}" style="background:#A87C2E;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-family:-apple-system,sans-serif;font-weight:600;display:inline-block;">Réinitialiser mon mot de passe</a>
      </p>
      <p style="font-size:13px;color:#8A7A74;">Ce lien est valide pendant 1 heure. Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer ce courriel sans crainte : votre mot de passe actuel reste inchangé.</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: email,
    subject: 'Réinitialisation de votre mot de passe — Vicky Doré',
    html,
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// Rappels automatiques — vérification périodique (toutes les 15 min)
// ============================================================
// Envoie un courriel de rappel aux clientes dont le rendez-vous CONFIRMÉ a
// lieu dans environ 24h. La fenêtre de tolérance (REMINDER_WINDOW_MINUTES)
// existe parce que la vérification ne tourne pas en continu, seulement à
// intervalles réguliers : sans cette marge, un rendez-vous pourrait passer
// entre deux vérifications sans jamais recevoir son rappel.
const REMINDER_CHECK_INTERVAL_MS = 15 * 60 * 1000; // toutes les 15 minutes
const REMINDER_TARGET_HOURS_BEFORE = 24;
const REMINDER_WINDOW_MINUTES = 20; // doit être > à la moitié de l'intervalle ci-dessus

async function checkAndSendReminders() {
  try {
    // Seules les réservations confirmées et pas déjà rappelées sont candidates.
    // On élargit la recherche aux deux derniers jours pour couvrir le passage
    // de minuit, puis on filtre précisément en JS avec la date/heure réelle.
    const candidates = db.prepare(`
      SELECT bookings.*, users.name as client_name, users.email as client_email
      FROM bookings
      JOIN users ON users.id = bookings.user_id
      WHERE bookings.status = 'confirme'
        AND bookings.reminder_sent_at IS NULL
        AND bookings.booking_date >= date('now')
        AND bookings.booking_date <= date('now', '+2 days')
    `).all();

    const now = Date.now();

    for (const booking of candidates) {
      const bookingMoment = new Date(`${booking.booking_date}T${booking.booking_time}:00`);
      if (Number.isNaN(bookingMoment.getTime())) continue;

      const minutesUntilBooking = (bookingMoment.getTime() - now) / (60 * 1000);
      const targetMinutes = REMINDER_TARGET_HOURS_BEFORE * 60;

      // On envoie le rappel dès que le rendez-vous entre dans la fenêtre des
      // 24h (avec une petite marge), et tant qu'il n'est pas encore passé.
      // Cette borne large (plutôt qu'une fenêtre étroite autour de 24h)
      // évite qu'un rappel soit manqué si le serveur était éteint au moment
      // précis où il aurait dû se déclencher (ex : ordinateur fermé la nuit) :
      // au prochain démarrage, le rendez-vous sera toujours détecté et rappelé,
      // pourvu qu'il reste encore à venir.
      const isWithinReminderWindow = minutesUntilBooking > 0 && minutesUntilBooking <= (targetMinutes + REMINDER_WINDOW_MINUTES);
      if (!isWithinReminderWindow) continue;

      try {
        await sendReminderEmail({
          clientName: booking.client_name,
          clientEmail: booking.client_email,
          serviceName: booking.service_name,
          bookingDateLabel: booking.booking_date_label,
          bookingTime: booking.booking_time,
        });
        db.prepare(`UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?`).run(booking.id);
        console.log(`✦ Rappel envoyé pour la réservation #${booking.id} (${booking.client_email})`);
      } catch (mailErr) {
        console.error(`⚠️  Erreur envoi rappel pour la réservation #${booking.id} :`, mailErr.message);
        // Pas de marquage reminder_sent_at en cas d'échec : on retentera à la prochaine vérification.
      }
    }
  } catch (err) {
    console.error('Erreur lors de la vérification des rappels :', err.message);
  }
}

// Premier passage peu après le démarrage (laisse le serveur finir de s'initialiser),
// puis vérification répétée toutes les 15 minutes tant que le serveur tourne.
setTimeout(checkAndSendReminders, 10 * 1000);
setInterval(checkAndSendReminders, REMINDER_CHECK_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`\n✦ Serveur Vicky Doré (TEST) démarré : http://localhost:${PORT}\n`);
});

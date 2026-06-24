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

if (!process.env.VICKY7UP_BASE_URL || !process.env.VICKY7UP_WEBHOOK_KEY) {
  console.warn('\n⚠️  VICKY7UP_BASE_URL ou VICKY7UP_WEBHOOK_KEY manquant dans .env — la synchronisation avec l\'app mobile sera désactivée.\n');
}

// ---------- Stockage persistant (base de données + images téléversées) ----------
// Sur Render (et tout hébergeur similaire), le système de fichiers du
// service est éphémère : tout ce qui est écrit pendant l'exécution (la base
// SQLite, les images de bannière promo) est perdu à chaque redéploiement, à
// moins de vivre sur un disque persistant attaché séparément.
//
// DATA_DIR doit être réglée sur le point de montage de ce disque persistant
// (ex. /data sur Render). En son absence (développement local), on
// retombe sur l'ancien comportement — un dossier "data" à côté du code —
// pour ne rien changer en local.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vickydore.db');

// Migration automatique, une seule fois : si une ancienne base existe encore
// à l'emplacement non persistant (__dirname/data) et qu'aucune base n'existe
// encore sur le disque persistant, on copie les données existantes plutôt
// que de repartir d'une base vide. Sans cette étape, le premier déploiement
// après l'ajout du disque persistant effacerait tout ce qui avait été saisi
// jusque-là (réservations, disponibilités, bannière promo, etc.).
const LEGACY_DB_PATH = path.join(__dirname, 'data', 'vickydore.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  console.log(`📦 Migration de la base existante vers le disque persistant : ${LEGACY_DB_PATH} → ${DB_PATH}`);
  fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
  // Les fichiers compagnons du mode WAL (write-ahead log) contiennent parfois
  // des écritures non encore appliquées à la base principale ; on les copie
  // aussi s'ils existent pour ne perdre aucune transaction récente.
  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = LEGACY_DB_PATH + suffix;
    if (fs.existsSync(legacySidecar)) fs.copyFileSync(legacySidecar, DB_PATH + suffix);
  }
}

// ---------- Base de données SQLite ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- Dossier des images téléversées (bannière promo) ----------
// Comme la base de données, ce dossier doit vivre sur le disque persistant
// (DATA_DIR) pour survivre aux redéploiements — sinon les bannières promo
// uploadées par Vicky disparaîtraient à chaque mise à jour du site, même si
// la base de données, elle, est correctement préservée.
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Migration automatique, une seule fois : copie les images déjà téléversées
// depuis l'ancien emplacement (public/uploads, non persistant) vers le
// disque persistant, pour ne pas perdre les bannières déjà en place au
// moment de la bascule.
const LEGACY_UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (uploadsDir !== LEGACY_UPLOADS_DIR && fs.existsSync(LEGACY_UPLOADS_DIR)) {
  for (const filename of fs.readdirSync(LEGACY_UPLOADS_DIR)) {
    const destPath = path.join(uploadsDir, filename);
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(path.join(LEGACY_UPLOADS_DIR, filename), destPath);
    }
  }
}

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
    vicky7up_external_id TEXT,        -- ID transmis à l'app Vicky7up (idempotency)
    vicky7up_synced_at TEXT,          -- NULL = pas encore synchronisé avec l'app mobile
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

  -- Deux emplacements de bannière promotionnelle indépendants (ex. un pour
  -- TikTok, un pour autre chose), chacun avec sa propre image et son propre
  -- lien de destination. id=1 et id=2 sont créés une fois pour toutes par
  -- l'INSERT OR IGNORE ci-dessous.
  CREATE TABLE IF NOT EXISTS promo_banner (
    id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
    image_path TEXT,
    link_url TEXT NOT NULL DEFAULT 'https://www.tiktok.com/@vickyyydore',
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Textes modifiables des pages publiques (Accueil et À propos), édités
  -- par Vicky depuis l'espace admin sans intervention du développeur.
  -- Clé-valeur simple : chaque "key" correspond à un bloc de texte précis
  -- (voir SITE_CONTENT_DEFAULTS plus bas pour la liste complète et les
  -- valeurs par défaut au premier démarrage).
  CREATE TABLE IF NOT EXISTS site_content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Registre des consentements à la collecte de renseignements personnels
  -- (Loi 25 du Québec / PIPEDA). Un enregistrement est créé à chaque
  -- inscription, et conservé même si le compte est supprimé plus tard,
  -- pour constituer une preuve de consentement horodatée.
  CREATE TABLE IF NOT EXISTS consent_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,              -- peut être NULL si le compte est supprimé ensuite
    email TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    ip_address TEXT,
    accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
    withdrawn_at TEXT              -- NULL = consentement toujours actif
  );

  -- Journal d'audit des suppressions de données (Loi 25 / PIPEDA) : garde
  -- une trace minimale (sans renseignements personnels identifiables) de
  -- chaque suppression automatique ou volontaire, pour pouvoir démontrer
  -- la conformité en cas de vérification.
  CREATE TABLE IF NOT EXISTS data_retention_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,      -- 'account_auto_deleted' / 'account_self_deleted' / 'bookings_purged'
    detail TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
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
if (!userColumns.includes('phone')) {
  db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
}
if (!userColumns.includes('synced_from_app')) {
  // 1 = compte créé automatiquement suite à une synchronisation depuis
  // l'app Vicky7up (le client n'a jamais créé de compte lui-même sur le
  // site et ne peut pas se connecter avec ce compte sans réinitialiser
  // son mot de passe).
  db.exec("ALTER TABLE users ADD COLUMN synced_from_app INTEGER NOT NULL DEFAULT 0");
}
if (!userColumns.includes('last_activity_at')) {
  // Mise à jour à chaque connexion réussie. Sert à détecter l'inactivité
  // (Loi 25 / PIPEDA) pour l'avertissement puis la suppression automatique
  // des comptes clients inactifs. Initialisée à la date de création pour
  // les comptes déjà existants, afin de ne pas tous les marquer "inactifs
  // depuis toujours" dès l'activation de cette fonctionnalité.
  db.exec("ALTER TABLE users ADD COLUMN last_activity_at TEXT");
  db.exec("UPDATE users SET last_activity_at = created_at WHERE last_activity_at IS NULL");
}
if (!userColumns.includes('inactivity_warning_sent_at')) {
  // NULL = aucun avertissement envoyé pour la période d'inactivité en cours.
  // Remis à NULL automatiquement dès que le compte redevient actif.
  db.exec("ALTER TABLE users ADD COLUMN inactivity_warning_sent_at TEXT");
}

const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!bookingColumns.includes('reminder_sent_at')) {
  db.exec('ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT');
}
if (!bookingColumns.includes('vicky7up_external_id')) {
  db.exec('ALTER TABLE bookings ADD COLUMN vicky7up_external_id TEXT');
}
if (!bookingColumns.includes('vicky7up_synced_at')) {
  db.exec('ALTER TABLE bookings ADD COLUMN vicky7up_synced_at TEXT');
}

// Migration légère : pause configurable entre les créneaux (ajoutée après
// la première version de business_hours).
const businessHoursColumns = db.prepare("PRAGMA table_info(business_hours)").all().map(c => c.name);
if (!businessHoursColumns.includes('break_between_slots_minutes')) {
  db.exec('ALTER TABLE business_hours ADD COLUMN break_between_slots_minutes INTEGER NOT NULL DEFAULT 0');
}

// Migration : la table promo_banner limitait initialement à une seule ligne
// (CHECK id = 1). On vérifie la contrainte effective en base et, si elle est
// encore l'ancienne version, on recrée la table avec la nouvelle contrainte
// (id IN (1, 2)) en conservant la ligne existante — nécessaire pour ajouter
// un deuxième emplacement de bannière sans perdre la configuration déjà en place.
const promoBannerTableSql = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='promo_banner'"
).get();
if (promoBannerTableSql && /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(promoBannerTableSql.sql)) {
  db.exec(`
    ALTER TABLE promo_banner RENAME TO promo_banner_old;
    CREATE TABLE promo_banner (
      id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
      image_path TEXT,
      link_url TEXT NOT NULL DEFAULT 'https://www.tiktok.com/@vickyyydore',
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO promo_banner (id, image_path, link_url, active, updated_at)
      SELECT id, image_path, link_url, active, updated_at FROM promo_banner_old;
    DROP TABLE promo_banner_old;
  `);
}

// Initialise les deux emplacements de bannière promo s'ils n'existent pas encore.
db.prepare('INSERT OR IGNORE INTO promo_banner (id) VALUES (1)').run();
db.prepare("INSERT OR IGNORE INTO promo_banner (id, link_url) VALUES (2, 'https://www.tiktok.com/@vickyyydore')").run();

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

// ---------- Textes modifiables (Accueil + À propos) : seed initial ----------
// Reprend exactement les textes codés en dur dans public/index.html au moment
// de la mise en place de cette fonctionnalité, pour qu'aucun changement
// visuel n'apparaisse tant que Vicky n'a rien modifié elle-même.
const SITE_CONTENT_DEFAULTS = {
  // --- Page Accueil : bloc principal (hero) ---
  home_eyebrow: '✦ Guidance intuitive &amp; soins énergétiques',
  home_title: 'Vicky Doré',
  home_tagline: 'Guidance &amp; Éveil',
  home_desc: 'Recevez des guidances intuitives et des soins énergétiques personnalisés afin de retrouver clarté, équilibre et alignement.',
  // --- Page Accueil : section "Mon approche" ---
  home_approach_eyebrow: 'Mon approche',
  home_approach_title: 'Un espace doux pour vous reconnecter à votre lumière intérieure',
  home_approach_p1: "Depuis plusieurs années, j'accompagne avec douceur les personnes en quête de sens, de clarté et d'alignement intérieur. Mon approche intuitive puise dans la guidance par les cartes et les soins énergétiques pour vous aider à libérer ce qui vous pèse et à retrouver votre propre boussole intérieure.",
  home_approach_p2: 'Chaque séance est un moment unique, entièrement adapté à votre chemin, dans un cadre bienveillant et sans jugement.',
  home_quote: "« Mon intention est de vous offrir un espace sacré où votre intuition peut s'exprimer librement. »",
  // --- Page Accueil : en-têtes des sections suivantes ---
  home_services_eyebrow: 'Mes services',
  home_services_title: 'Des séances pensées pour vous',
  home_services_desc: 'Que vous cherchiez une réponse rapide ou un accompagnement plus profond, chaque service est conçu pour répondre à votre besoin du moment.',
  home_testimonials_eyebrow: 'Témoignages',
  home_testimonials_title: 'Ce que partagent les personnes accompagnées',
  home_faq_eyebrow: 'Questions fréquentes',
  home_faq_title: "Tout ce qu'il faut savoir",

  // --- Page À propos : en-tête ---
  about_eyebrow: 'Mon histoire',
  about_title: 'À propos de Vicky Doré',
  // --- Page À propos : "Mon parcours" ---
  about_journey_eyebrow: 'Mon parcours',
  about_journey_title: "Une vocation née de l'intuition",
  about_journey_p1: "Mon chemin vers la guidance intuitive et les soins énergétiques s'est dessiné naturellement, au fil de mes propres expériences de transformation intérieure. J'ai appris à faire confiance à mon intuition et à utiliser des outils comme le tarot et le soin énergétique pour accompagner celles et ceux qui traversent des périodes de questionnement.",
  about_journey_p2: "Aujourd'hui, c'est avec une profonde gratitude que j'offre cet espace d'écoute et de guidance à toute personne en quête de clarté, d'équilibre et d'alignement.",
  // --- Page À propos : "Ma mission" ---
  about_mission_eyebrow: 'Ma mission',
  about_mission_title: 'Vous aider à retrouver votre propre lumière',
  about_mission_text: "Ma mission est simple : créer un espace sacré et sécurisant où vous pouvez déposer vos questionnements et repartir avec des pistes claires pour avancer. Je crois profondément que chacun possède en lui les réponses dont il a besoin — mon rôle est de vous aider à les entendre.",
  // --- Page À propos : "Mon approche" ---
  about_approach_eyebrow: 'Mon approche',
  about_approach_title: 'Une guidance intuitive et énergétique',
  about_approach_text: "Mon approche combine la guidance par les cartes, l'écoute intuitive et les soins énergétiques. Chaque séance est pensée pour répondre précisément à votre besoin du moment, qu'il s'agisse d'obtenir une réponse claire sur une situation précise, ou de vivre un moment de rééquilibrage profond du corps et de l'esprit.",
  // --- Page À propos : "Mes valeurs" (4 cartes) ---
  about_values_eyebrow: 'Mes valeurs',
  about_values_title: "Pourquoi choisir cet accompagnement",
  about_value1_icon: '👂',
  about_value1_title: 'Écoute',
  about_value1_text: 'Chaque rencontre commence par une écoute sincère, sans jugement.',
  about_value2_icon: '💛',
  about_value2_title: 'Bienveillance',
  about_value2_text: "Un accompagnement empreint de douceur et d'accueil.",
  about_value3_icon: '✨',
  about_value3_title: 'Intuition',
  about_value3_text: 'Une guidance qui éclaire votre chemin.',
  about_value4_icon: '🤲',
  about_value4_title: 'Accompagnement personnalisé',
  about_value4_text: 'Chaque séance ajustée à votre rythme.',
};

function ensureSiteContentSeed() {
  const insert = db.prepare(`INSERT OR IGNORE INTO site_content (key, value) VALUES (?, ?)`);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  tx(Object.entries(SITE_CONTENT_DEFAULTS));
}
ensureSiteContentSeed();

function getSiteContent() {
  const rows = db.prepare('SELECT key, value FROM site_content').all();
  const content = { ...SITE_CONTENT_DEFAULTS };
  for (const row of rows) content[row.key] = row.value;
  return content;
}

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

// Version actuelle de la politique de confidentialité. À incrémenter
// manuellement chaque fois que le texte de la politique change de façon
// significative — les consentements déjà enregistrés gardent la version
// qui était en vigueur au moment de l'inscription, pour garder une preuve
// fidèle de ce à quoi la cliente a réellement consenti.
const PRIVACY_POLICY_VERSION = '2026-06-23';

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
// Sert les images téléversées sous la même URL publique qu'avant
// (/uploads/...), peu importe où elles vivent réellement sur le disque.
// Déclarée avant le middleware express.static générique ci-dessous pour
// être prioritaire sur lui.
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Middlewares d'authentification
// ============================================================
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Vous devez être connecté.' });
  // Maintient last_activity_at à jour pendant toute la durée d'une session
  // active, pas seulement au moment de la connexion (une session dure
  // jusqu'à 30 jours). Non-bloquant : une erreur ici ne doit jamais empêcher
  // la requête en cours de continuer.
  try {
    db.prepare(`UPDATE users SET last_activity_at = datetime('now'), inactivity_warning_sent_at = NULL WHERE id = ?`)
      .run(req.session.userId);
  } catch (e) { /* silencieux */ }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé à l\'administration.' });
  }
  next();
}

// Règle de robustesse du mot de passe, appliquée partout où un mot de passe
// est créé ou modifié (inscription, réinitialisation, changement de mot de
// passe client ou admin) : au moins 8 caractères, une majuscule et un
// caractère spécial. Retourne null si valide, ou un message d'erreur en
// français destiné à être renvoyé directement au frontend.
function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Le mot de passe doit contenir au moins 8 caractères.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Le mot de passe doit contenir au moins une lettre majuscule.';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'Le mot de passe doit contenir au moins un caractère spécial.';
  }
  return null;
}

// ---------- Upload d'image pour la bannière publicitaire ----------
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
    const { name, email, password, birthDate, city, consentAccepted } = req.body;
    if (!name || !email || !password || !birthDate || !city) return res.status(400).json({ error: 'Champs manquants.' });
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    // Le consentement à la collecte de renseignements personnels (Loi 25 /
    // PIPEDA) est obligatoire. Le frontend ne permet normalement pas
    // d'arriver ici sans avoir cliqué « J'accepte » dans la fenêtre de
    // consentement, mais on revalide côté serveur par sécurité.
    if (consentAccepted !== true) {
      return res.status(400).json({ error: 'Vous devez accepter la politique de confidentialité pour créer un compte.' });
    }

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

    // Enregistrement du consentement (Loi 25 / PIPEDA) : horodatage, version
    // de la politique acceptée, et adresse IP, conservés indépendamment du
    // compte pour servir de preuve même si le compte est supprimé ensuite.
    try {
      const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      db.prepare(`
        INSERT INTO consent_records (user_id, email, policy_version, ip_address)
        VALUES (?, ?, ?, ?)
      `).run(user.id, normalizedEmail, PRIVACY_POLICY_VERSION, clientIp || null);
    } catch (consentErr) {
      // Ne doit jamais empêcher la création du compte ; on logue pour pouvoir
      // vérifier manuellement si l'enregistrement du consentement a échoué.
      console.error('⚠️  Erreur enregistrement du consentement :', consentErr.message);
    }

    // Synchronisation avec l'app mobile Vicky7up : non-bloquante, l'inscription
    // reste valide même si l'app mobile ne reçoit pas la notification.
    const [firstName, ...rest] = name.trim().split(/\s+/);
    notifyVicky7upClient({
      userId: user.id,
      firstName: firstName || name.trim(),
      lastName: rest.join(' '),
      email: normalizedEmail,
      phone: '',
    });

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
    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });

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

    // Une connexion réussie marque le compte comme actif : on annule tout
    // avertissement d'inactivité déjà envoyé pour la période précédente.
    db.prepare(`UPDATE users SET last_activity_at = datetime('now'), inactivity_warning_sent_at = NULL WHERE id = ?`)
      .run(row.id);

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

// Changement de mot de passe par la personne elle-même (cliente ou admin),
// une fois connectée. Exige le mot de passe actuel pour confirmer
// l'identité, distinct du flux « mot de passe oublié » qui passe par un
// jeton envoyé par courriel.
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs manquants.' });

    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Session invalide.' });

    const matches = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!matches) return res.status(400).json({ error: 'Le mot de passe actuel est incorrect.' });

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur change-password :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
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

    // Synchronisation avec l'app mobile Vicky7up : non-bloquante, la
    // réservation reste valide même si l'app mobile ne reçoit pas la notification.
    notifyVicky7upCreate({
      bookingId: result.lastInsertRowid,
      clientName: user.name,
      clientEmail: user.email,
      service,
      bookingDate,
      bookingTime,
    });

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
  notifyVicky7upCancel({ bookingId: booking.id, vicky7upExternalId: booking.vicky7up_external_id });
  res.json({ success: true });
});

// Suppression volontaire du compte par la cliente elle-même (Loi 25 / PIPEDA).
// Irréversible : supprime le compte ainsi que toutes les données qui s'y
// rattachent (réservations, conversation, témoignages). Réservée aux
// comptes "client" : un compte admin ne peut pas se supprimer par cette voie.
app.post('/api/account/delete', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.role !== 'client') {
      return res.status(403).json({ error: 'Cette action n\'est pas disponible pour ce type de compte.' });
    }

    deleteClientAccount(user.id);
    logRetentionEvent('account_self_deleted', `Compte client #${user.id} supprimé volontairement par la cliente.`);
    req.session = null; // termine la session active immédiatement
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur suppression volontaire du compte :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de la suppression du compte.' });
  }
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
  const rows = db.prepare(`SELECT id, name, email, phone, synced_from_app, created_at FROM users WHERE role = 'client' ORDER BY created_at DESC`).all();
  res.json(rows);
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

  // Synchronisation avec l'app mobile Vicky7up, toujours non-bloquante.
  if (status === 'annule') {
    notifyVicky7upCancel({ bookingId: booking.id, vicky7upExternalId: booking.vicky7up_external_id });
  } else if (!booking.vicky7up_external_id) {
    // Rattrapage : la sync initiale (à la création) avait échoué — on retente ici.
    notifyVicky7upCreate({
      bookingId: booking.id,
      clientName: booking.client_name,
      clientEmail: booking.client_email,
      service: { name: booking.service_name },
      bookingDate: booking.booking_date,
      bookingTime: booking.booking_time,
    });
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

// Crée un ou plusieurs blocages en une seule opération : jour complet
// (startTime/endTime omis) ou plage précise. Accepte soit { blockedDate }
// pour un seul jour (rétrocompatibilité), soit { blockedDates: [...] } pour
// bloquer plusieurs dates d'un coup avec le même motif/plage horaire.
app.post('/api/admin/blocked-periods', requireAdmin, (req, res) => {
  try {
    const { blockedDate, blockedDates, startTime, endTime, reason } = req.body;

    // Normalise en tableau de dates, sans doublons, sans valeurs vides.
    let dates = Array.isArray(blockedDates) ? blockedDates.filter(Boolean) : [];
    if (blockedDate) dates.push(blockedDate);
    dates = [...new Set(dates)];

    if (dates.length === 0) return res.status(400).json({ error: 'Veuillez choisir au moins une date.' });

    if ((startTime && !endTime) || (!startTime && endTime)) {
      return res.status(400).json({ error: 'Indiquez une heure de début ET de fin, ou laissez les deux vides pour bloquer la journée complète.' });
    }
    if (startTime && endTime && timeToMinutes(startTime) >= timeToMinutes(endTime)) {
      return res.status(400).json({ error: 'L\'heure de début doit précéder l\'heure de fin.' });
    }

    const insert = db.prepare(`
      INSERT INTO blocked_periods (blocked_date, start_time, end_time, reason)
      VALUES (?, ?, ?, ?)
    `);
    const insertMany = db.transaction((dateList) => {
      const ids = [];
      for (const d of dateList) {
        const result = insert.run(d, startTime || null, endTime || null, (reason || '').trim());
        ids.push(result.lastInsertRowid);
      }
      return ids;
    });
    const ids = insertMany(dates);

    res.json({ success: true, ids, count: ids.length });
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



// ============================================================
// TEXTES MODIFIABLES — pages Accueil et À propos
// ============================================================
// Liste des clés autorisées : toute clé hors de cette liste est rejetée par
// la route d'enregistrement, pour éviter qu'un appel malformé ne crée des
// entrées orphelines en base.
const SITE_CONTENT_KEYS = Object.keys(SITE_CONTENT_DEFAULTS);

// Accessible à tout le monde : permet au frontend de connaître la version
// actuelle de la politique de confidentialité, affichée dans la fenêtre de
// consentement à l'inscription.
app.get('/api/privacy-policy-version', (req, res) => {
  res.json({ version: PRIVACY_POLICY_VERSION });
});

// Accessible à tout le monde : le site charge ces textes pour afficher
// les pages Accueil et À propos avec le contenu actuel (modifié ou par défaut).
app.get('/api/site-content', (req, res) => {
  res.json(getSiteContent());
});

// Admin seulement : liste les textes actuels (identique à la route publique,
// mais group separately for clarity dans le panneau admin).
app.get('/api/admin/site-content', requireAdmin, (req, res) => {
  res.json(getSiteContent());
});

// Admin seulement : enregistre un lot de modifications de texte. Le corps
// attendu est un objet { clé: valeur, ... } — seules les clés reconnues
// (SITE_CONTENT_KEYS) sont prises en compte, le reste est silencieusement ignoré.
app.put('/api/admin/site-content', requireAdmin, (req, res) => {
  try {
    const updates = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    const tx = db.transaction((entries) => {
      for (const [key, value] of entries) {
        if (!SITE_CONTENT_KEYS.includes(key)) continue;
        upsert.run(key, String(value ?? ''));
      }
    });
    tx(Object.entries(updates));
    res.json({ success: true, content: getSiteContent() });
  } catch (err) {
    console.error('Erreur mise à jour des textes du site :', err.message);
    res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement.' });
  }
});

// Accessible à tout le monde : la page d'accueil affiche les bannières si elles existent.
// ?slot=1 ou ?slot=2 pour récupérer un emplacement précis ; sans paramètre,
// retourne les deux dans un tableau pour rester pratique côté frontend.
app.get('/api/promo-banner', (req, res) => {
  const slotParam = parseInt(req.query.slot, 10);

  if (slotParam === 1 || slotParam === 2) {
    const row = db.prepare('SELECT * FROM promo_banner WHERE id = ?').get(slotParam);
    if (!row) return res.json({ active: false, imagePath: null, linkUrl: null });
    return res.json({
      active: Boolean(row.active) && Boolean(row.image_path),
      imagePath: row.image_path,
      linkUrl: row.link_url,
    });
  }

  const rows = db.prepare('SELECT * FROM promo_banner ORDER BY id ASC').all();
  res.json(rows.map(row => ({
    slot: row.id,
    active: Boolean(row.active) && Boolean(row.image_path),
    imagePath: row.image_path,
    linkUrl: row.link_url,
  })));
});

// Admin seulement : téléverse une nouvelle image pour l'un des deux emplacements de bannière.
// L'ancienne image (si elle existe) est supprimée du disque pour ne pas accumuler de fichiers inutiles.
app.post('/api/admin/promo-banner/image', requireAdmin, (req, res) => {
  promoUpload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Erreur lors du téléversement.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Aucune image reçue.' });
    }
    const slot = parseInt(req.body.slot, 10) === 2 ? 2 : 1;
    try {
      const previous = db.prepare('SELECT image_path FROM promo_banner WHERE id = ?').get(slot);
      const newPath = `/uploads/${req.file.filename}`;

      db.prepare(`
        UPDATE promo_banner SET image_path = ?, active = 1, updated_at = datetime('now') WHERE id = ?
      `).run(newPath, slot);

      if (previous && previous.image_path) {
        const oldFile = path.join(uploadsDir, path.basename(previous.image_path));
        fs.unlink(oldFile, () => {}); // suppression silencieuse, sans bloquer la réponse
      }

      res.json({ success: true, imagePath: newPath, slot });
    } catch (dbErr) {
      console.error('Erreur enregistrement bannière promo :', dbErr.message);
      res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement.' });
    }
  });
});

// Admin seulement : met à jour le lien de destination et/ou active ou désactive
// l'un des deux emplacements de bannière, sans nécessiter un nouveau téléversement d'image.
app.put('/api/admin/promo-banner', requireAdmin, (req, res) => {
  try {
    const { linkUrl, active } = req.body;
    const slot = parseInt(req.body.slot, 10) === 2 ? 2 : 1;
    const current = db.prepare('SELECT * FROM promo_banner WHERE id = ?').get(slot);

    const newLink = (linkUrl !== undefined && linkUrl !== null && linkUrl.trim() !== '')
      ? linkUrl.trim()
      : current.link_url;
    const newActive = (active !== undefined) ? (active ? 1 : 0) : current.active;

    db.prepare(`
      UPDATE promo_banner SET link_url = ?, active = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newLink, newActive, slot);

    res.json({ success: true, slot });
  } catch (err) {
    console.error('Erreur mise à jour bannière promo :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Admin seulement : retire complètement l'image actuelle d'un emplacement (la bannière redevient masquée).
app.delete('/api/admin/promo-banner/image', requireAdmin, (req, res) => {
  try {
    const slot = parseInt(req.query.slot, 10) === 2 ? 2 : 1;
    const current = db.prepare('SELECT image_path FROM promo_banner WHERE id = ?').get(slot);
    if (current && current.image_path) {
      const oldFile = path.join(uploadsDir, path.basename(current.image_path));
      fs.unlink(oldFile, () => {});
    }
    db.prepare(`UPDATE promo_banner SET image_path = NULL, active = 0, updated_at = datetime('now') WHERE id = ?`).run(slot);
    res.json({ success: true, slot });
  } catch (err) {
    console.error('Erreur suppression bannière promo :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ============================================================
// Synchronisation avec l'app mobile Vicky7up (Emergent)
// ============================================================
// Le site reste la seule source de vérité pour les réservations.
// Après chaque création/changement de statut réussi en base, on notifie
// Vicky7up par webhook pour que l'app mobile reflète l'état du site
// (email de confirmation au client, notification push à l'admin).
// Toujours non-bloquant : un échec ici ne doit jamais empêcher ou annuler
// une réservation déjà enregistrée côté site.

const VICKY7UP_BASE_URL = (process.env.VICKY7UP_BASE_URL || '').replace(/\/$/, '');
const VICKY7UP_WEBHOOK_KEY = process.env.VICKY7UP_WEBHOOK_KEY || '';

// Clé attendue sur les webhooks ENTRANTS depuis Vicky7up (sens inverse de
// VICKY7UP_WEBHOOK_KEY ci-dessus, qui sert aux appels SORTANTS du site vers
// l'app). Doit correspondre à VICKYDORE_WEBHOOK_KEY dans le .env de Vicky7up.
const VICKY7UP_TO_SITE_KEY = process.env.VICKY7UP_TO_SITE_KEY || '';

// Cache en mémoire du mapping "nom de service du site" → "service_id Vicky7up".
// Rechargé automatiquement si un nom demandé n'est pas (encore) dans le cache,
// au cas où un service serait ajouté côté app après le démarrage du serveur.
let vicky7upServiceCache = null; // Map<nom_normalisé, service_id>

function normalizeServiceName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // retire les accents
}

async function vicky7upFetch(path, options = {}) {
  if (!VICKY7UP_BASE_URL || !VICKY7UP_WEBHOOK_KEY) {
    throw new Error('Vicky7up non configuré (VICKY7UP_BASE_URL / VICKY7UP_WEBHOOK_KEY manquant).');
  }
  const res = await fetch(`${VICKY7UP_BASE_URL}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Key': VICKY7UP_WEBHOOK_KEY,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (parseErr) {
    // La réponse n'est pas du JSON valide (ex: page d'erreur HTML, texte brut).
    // On logue le corps brut (tronqué) pour pouvoir diagnostiquer, plutôt que
    // de masquer l'erreur réelle derrière une erreur de parsing JSON.
    const err = new Error(`Réponse Vicky7up non-JSON (HTTP ${res.status}) : ${text.slice(0, 200)}`);
    err.status = res.status;
    err.rawBody = text;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(body?.detail || res.statusText || 'Erreur Vicky7up');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Récupère (et met en cache) la liste des services publics Vicky7up,
// puis retourne le service_id correspondant au nom de service du site.
async function getVicky7upServiceId(serviceName) {
  const target = normalizeServiceName(serviceName);

  if (vicky7upServiceCache && vicky7upServiceCache.has(target)) {
    return vicky7upServiceCache.get(target);
  }

  const services = await vicky7upFetch('/services/public');
  vicky7upServiceCache = new Map();
  for (const s of services) {
    // On mappe sur le nom français, qui correspond aux noms utilisés sur le site.
    vicky7upServiceCache.set(normalizeServiceName(s.name_fr || s.name), s.id);
  }

  if (!vicky7upServiceCache.has(target)) {
    throw new Error(`Aucun service Vicky7up ne correspond au nom "${serviceName}".`);
  }
  return vicky7upServiceCache.get(target);
}

// Notifie Vicky7up de la création d'une réservation. Retourne l'external_id
// utilisé (à sauvegarder en base pour permettre l'annulation plus tard) ou
// null en cas d'échec — l'appelant ne doit jamais bloquer sur ce retour.
async function notifyVicky7upCreate({ bookingId, clientName, clientEmail, service, bookingDate, bookingTime, notes }) {
  try {
    const serviceId = await getVicky7upServiceId(service.name);
    const externalId = `vd-${bookingId}`;

    const [firstName, ...rest] = String(clientName || '').trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    const appointment = await vicky7upFetch('/webhook/appointment', {
      method: 'POST',
      body: JSON.stringify({
        client_first_name: firstName || clientName,
        client_last_name: lastName,
        email: String(clientEmail || '').trim().toLowerCase(),
        phone: '',
        service_id: serviceId,
        date: bookingDate,
        time: bookingTime,
        notes: notes || '',
        language: 'fr',
        external_id: externalId,
      }),
    });

    db.prepare(`UPDATE bookings SET vicky7up_external_id = ?, vicky7up_synced_at = datetime('now') WHERE id = ?`)
      .run(externalId, bookingId);

    return { externalId, appointment };
  } catch (err) {
    console.error('⚠️  [Vicky7up] Échec de la synchronisation (réservation tout de même enregistrée sur le site) :', err.message);
    return null;
  }
}

// Notifie Vicky7up de l'annulation d'une réservation déjà synchronisée.
// Ne fait rien si la réservation n'avait jamais été synchronisée (ex: créée
// avant l'activation de l'intégration, ou échec lors de la création).
async function notifyVicky7upCancel({ bookingId, vicky7upExternalId }) {
  if (!vicky7upExternalId) return;
  try {
    await vicky7upFetch('/webhook/appointment/cancel', {
      method: 'POST',
      body: JSON.stringify({ external_id: vicky7upExternalId }),
    });
  } catch (err) {
    console.error('⚠️  [Vicky7up] Échec de la notification d\'annulation :', err.message, '(booking', bookingId, ')');
  }
}

// Notifie Vicky7up qu'un nouveau compte client existe sur le site, même
// s'il n'a pas encore pris de rendez-vous. Toujours non-bloquant.
async function notifyVicky7upClient({ userId, firstName, lastName, email, phone }) {
  try {
    await vicky7upFetch('/webhook/client', {
      method: 'POST',
      body: JSON.stringify({
        first_name: firstName || '',
        last_name: lastName || '',
        email: String(email || '').trim().toLowerCase(),
        phone: phone || '',
        language: 'fr',
        external_id: String(userId),
      }),
    });
  } catch (err) {
    console.error('⚠️  [Vicky7up] Échec de la synchronisation du client :', err.message, '(user', userId, ')');
  }
}

// Webhook ENTRANT : Vicky7up notifie le site qu'un client existe côté app
// (ex: créé manuellement par Vicky lors d'un rendez-vous pris par téléphone),
// même sans avoir jamais visité le site. On crée un compte "fantôme" : il
// existe pour que Vicky le voie listé des deux côtés, mais ne peut pas s'en
// servir pour se connecter sans passer par "mot de passe oublié" au préalable
// (le hash stocké est aléatoire et n'est jamais communiqué à personne).
app.post('/api/webhook/client', (req, res) => {
  try {
    const key = req.get('X-Webhook-Key');
    if (!VICKY7UP_TO_SITE_KEY || key !== VICKY7UP_TO_SITE_KEY) {
      return res.status(401).json({ error: 'Clé de webhook invalide.' });
    }

    const { firstName, lastName, email, phone } = req.body || {};
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: 'Email manquant.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const fullName = `${firstName || ''} ${lastName || ''}`.trim() || normalizedEmail;

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      // Le compte existe déjà (probablement créé directement sur le site) :
      // on ne fait que compléter le téléphone si celui-ci était vide, sans
      // jamais écraser un nom déjà choisi par la cliente elle-même.
      if (phone) {
        db.prepare('UPDATE users SET phone = COALESCE(phone, ?) WHERE id = ?').run(phone, existing.id);
      }
      return res.json({ success: true, userId: existing.id, created: false });
    }

    // Mot de passe aléatoire et inutilisable : ce compte ne sert qu'à
    // l'affichage côté admin, jamais à une connexion directe.
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hash = bcrypt.hashSync(randomPassword, 10);

    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, phone, role, synced_from_app)
      VALUES (?, ?, ?, ?, 'client', 1)
    `).run(fullName, normalizedEmail, hash, phone || null);

    res.json({ success: true, userId: result.lastInsertRowid, created: true });
  } catch (err) {
    console.error('Erreur webhook client (Vicky7up) :', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// Webhook ENTRANT : Vicky7up notifie le site d'un changement d'état sur un
// rendez-vous initié depuis l'app (annulation, complété, reporté, supprimé).
// On retrouve la réservation via vicky7up_external_id (format "vd-{id}",
// attribué lors de la synchronisation initiale côté site). Si la réservation
// n'est pas retrouvée (jamais synchronisée, ou déjà traitée), on répond 200
// quand même : Vicky7up ne doit jamais retenter indéfiniment pour ça.
app.post('/api/webhook/vicky7up', async (req, res) => {
  try {
    const key = req.get('X-Webhook-Key');
    if (!VICKY7UP_TO_SITE_KEY || key !== VICKY7UP_TO_SITE_KEY) {
      return res.status(401).json({ error: 'Clé de webhook invalide.' });
    }

    const { event, external_id, date, time } = req.body || {};
    if (!event || !external_id) {
      return res.status(400).json({ error: 'Champs event/external_id manquants.' });
    }

    console.log(`📬 [Vicky7up→Site] Événement reçu : ${event} (external_id=${external_id})`);

    const booking = db.prepare(`
      SELECT bookings.*, users.name as client_name, users.email as client_email
      FROM bookings JOIN users ON users.id = bookings.user_id
      WHERE bookings.vicky7up_external_id = ?
    `).get(external_id);

    if (!booking) {
      console.warn(`⚠️  [Vicky7up→Site] Aucune réservation locale pour external_id=${external_id} — ignoré.`);
      return res.json({ ok: true, matched: false });
    }

    switch (event) {
      case 'cancelled': {
        db.prepare(`UPDATE bookings SET status = 'annule' WHERE id = ?`).run(booking.id);
        try {
          await sendConfirmationEmails({
            clientName: booking.client_name,
            clientEmail: booking.client_email,
            service: { name: booking.service_name, price: formatPriceLabel(booking.service_price_cents) },
            bookingDateLabel: booking.booking_date_label,
            bookingTime: booking.booking_time,
            paymentMethod: booking.payment_method,
            status: 'annule',
            notifyAdmin: false,
          });
        } catch (emailErr) {
          console.error('⚠️  Erreur envoi courriel (annulation via app) :', emailErr.message);
        }
        break;
      }

      case 'completed': {
        // Pas de statut "complété" distinct côté site : on considère le
        // rendez-vous toujours confirmé (il a bien eu lieu). Pas de courriel
        // ici, puisque le client a déjà reçu sa confirmation initiale.
        db.prepare(`UPDATE bookings SET status = 'confirme' WHERE id = ?`).run(booking.id);
        break;
      }

      case 'rescheduled': {
        if (!date || !time) {
          console.warn(`⚠️  [Vicky7up→Site] 'rescheduled' reçu sans date/heure pour external_id=${external_id}.`);
          break;
        }
        db.prepare(`UPDATE bookings SET booking_date = ?, booking_date_label = ?, booking_time = ? WHERE id = ?`)
          .run(date, date, time, booking.id);
        try {
          await sendConfirmationEmails({
            clientName: booking.client_name,
            clientEmail: booking.client_email,
            service: { name: booking.service_name, price: formatPriceLabel(booking.service_price_cents) },
            bookingDateLabel: date,
            bookingTime: time,
            paymentMethod: booking.payment_method,
            status: booking.status,
            notifyAdmin: false,
          });
        } catch (emailErr) {
          console.error('⚠️  Erreur envoi courriel (reporté via app) :', emailErr.message);
        }
        break;
      }

      case 'deleted': {
        db.prepare(`DELETE FROM bookings WHERE id = ?`).run(booking.id);
        break;
      }

      default:
        console.warn(`⚠️  [Vicky7up→Site] Type d'événement inconnu : ${event}`);
    }

    res.json({ ok: true, matched: true });
  } catch (err) {
    console.error('Erreur webhook Vicky7up (événement rendez-vous) :', err.message);
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
// CYCLE DE VIE DES DONNÉES — Loi 25 / PIPEDA
// ============================================================
// Durées de conservation choisies avec Vicky :
//  - Rendez-vous : 18 mois (besoin comptable/fiscal réel), au-delà de quoi
//    ils sont supprimés même si le compte client reste actif.
//  - Comptes clients inactifs : avertis à 170 jours, supprimés à 183 jours
//    sans aucune activité (connexion ou requête authentifiée).
const BOOKING_RETENTION_DAYS = 18 * 30; // 18 mois ≈ 540 jours
const INACTIVITY_WARNING_DAYS = 170;
const INACTIVITY_DELETE_DAYS = 183;

function logRetentionEvent(eventType, detail) {
  try {
    db.prepare(`INSERT INTO data_retention_log (event_type, detail) VALUES (?, ?)`).run(eventType, detail || '');
  } catch (e) {
    console.error('⚠️  Erreur journal de rétention :', e.message);
  }
}

// Supprime intégralement un compte client et toutes les données qui s'y
// rattachent directement (réservations, conversation, témoignages, jetons
// de réinitialisation). Les enregistrements de consentement sont
// volontairement conservés (avec user_id mis à NULL) : ils constituent une
// preuve historique du consentement donné, indépendante de l'existence du compte.
function deleteClientAccount(userId) {
  const conversation = db.prepare('SELECT id FROM conversations WHERE user_id = ?').get(userId);
  if (conversation) {
    db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conversation.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
  }
  db.prepare('DELETE FROM testimonials WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM bookings WHERE user_id = ?').run(userId);
  db.prepare('UPDATE consent_records SET user_id = NULL WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Purge les réservations dont la date dépasse la durée de conservation,
// peu importe le statut (confirmée, annulée, etc.) et même si le compte
// client associé reste actif — seules les vieilles réservations sont visées,
// pas le compte lui-même.
async function purgeOldBookings() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - BOOKING_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const result = db.prepare(`DELETE FROM bookings WHERE booking_date < ?`).run(cutoffStr);
    if (result.changes > 0) {
      logRetentionEvent('bookings_purged', `${result.changes} réservation(s) antérieure(s) au ${cutoffStr} supprimée(s).`);
      console.log(`✦ Rétention : ${result.changes} réservation(s) de plus de ${BOOKING_RETENTION_DAYS} jours purgée(s).`);
    }
  } catch (err) {
    console.error('Erreur lors de la purge des réservations :', err.message);
  }
}

// Avertit les comptes approchant la limite d'inactivité, puis supprime
// ceux qui l'ont dépassée. Le compte admin (Vicky) est explicitement exclu,
// puisque cette politique ne vise que les comptes clients.
async function manageInactiveAccounts() {
  try {
    const warningCutoff = new Date();
    warningCutoff.setDate(warningCutoff.getDate() - INACTIVITY_WARNING_DAYS);
    const warningCutoffStr = warningCutoff.toISOString();

    const toWarn = db.prepare(`
      SELECT * FROM users
      WHERE role = 'client'
        AND last_activity_at <= ?
        AND inactivity_warning_sent_at IS NULL
    `).all(warningCutoffStr);

    for (const user of toWarn) {
      try {
        await sendInactivityWarningEmail({ name: user.name, email: user.email });
        db.prepare(`UPDATE users SET inactivity_warning_sent_at = datetime('now') WHERE id = ?`).run(user.id);
      } catch (mailErr) {
        console.error(`⚠️  Erreur envoi avertissement d'inactivité (user ${user.id}) :`, mailErr.message);
      }
    }

    const deleteCutoff = new Date();
    deleteCutoff.setDate(deleteCutoff.getDate() - INACTIVITY_DELETE_DAYS);
    const deleteCutoffStr = deleteCutoff.toISOString();

    const toDelete = db.prepare(`
      SELECT id, email FROM users
      WHERE role = 'client'
        AND last_activity_at <= ?
    `).all(deleteCutoffStr);

    for (const user of toDelete) {
      deleteClientAccount(user.id);
      logRetentionEvent('account_auto_deleted', `Compte client #${user.id} supprimé après ${INACTIVITY_DELETE_DAYS} jours d'inactivité.`);
      console.log(`✦ Rétention : compte client #${user.id} supprimé automatiquement (inactivité).`);
    }
  } catch (err) {
    console.error('Erreur lors de la gestion des comptes inactifs :', err.message);
  }
}

async function sendInactivityWarningEmail({ name, email }) {
  const fromAddress = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const html = `
    <div style="font-family:Georgia,serif;color:#352B28;max-width:480px;margin:0 auto;">
      <h2 style="color:#A87C2E;">Votre compte est inactif ✦</h2>
      <p>Bonjour ${escapeHtml(name)},</p>
      <p>Nous avons remarqué que vous ne vous êtes pas connectée à votre compte depuis un certain temps.</p>
      <p>Conformément à notre politique de conservation des renseignements personnels, votre compte et les données qui y sont associées (historique de réservations, messages) seront <strong>supprimés définitivement dans environ 13 jours</strong> si aucune activité n'est détectée.</p>
      <p>Pour conserver votre compte, il suffit de vous connecter une fois sur le site avant cette échéance.</p>
      <p style="font-size:13px;color:#8A7A74;margin-top:20px;">Si vous souhaitez plutôt supprimer votre compte dès maintenant, vous pouvez le faire vous-même depuis votre profil, dans la section « Mon compte ».</p>
      <p>Au plaisir de vous accompagner,<br>Vicky Doré</p>
    </div>
  `;
  await resend.emails.send({
    from: fromAddress,
    to: email,
    subject: 'Votre compte sera bientôt supprimé pour inactivité — Vicky Doré',
    html,
  });
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

// ============================================================
// Cycle de vie des données — vérification quotidienne
// ============================================================
// Une fois par jour suffit largement pour des durées de conservation
// comptées en mois/jours : pas besoin d'une fréquence aussi élevée que
// les rappels de rendez-vous.
const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // toutes les 24h
setTimeout(() => { purgeOldBookings(); manageInactiveAccounts(); }, 30 * 1000);
setInterval(() => { purgeOldBookings(); manageInactiveAccounts(); }, RETENTION_CHECK_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`\n✦ Serveur Vicky Doré (TEST) démarré : http://localhost:${PORT}\n`);
});

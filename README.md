# FitAI Pro v2.0

Application de coaching fitness alimentée par l'IA.

## 🚀 Fonctionnalités

### Coach IA Amélioré
- Génération de programmes personnalisés selon objectif, niveau, équipement
- Prise en compte des blessures et limitations
- Alternatives pour chaque exercice
- Structure détaillée: échauffement, corps principal, récupération

### Body Scan Enrichi
- Score physique global (0-100)
- Analyse posture détaillée
- Équilibre musculaire (points forts/faibles)
- Recommandations personnalisées
- Suivi de progression vs scans précédents

### Communauté v2
- Système de commentaires
- Kudos sécurisés (anti-double)
- Système de streaks automatique
- Différents types de posts (texte, workout, transformation)

### Nutrition
- Tracking des macros quotidiens
- Objectifs personnalisés
- Progression visuelle

## 📦 Stack technique

- **Frontend**: Vanilla JS, HTML, CSS
- **Backend**: Vercel Serverless Functions
- **Database**: Supabase (PostgreSQL + Auth + Storage)
- **AI**: Google Gemini 2.0 Flash

## 🔧 Installation

### 1. Cloner et déployer sur Vercel

```bash
git clone <repo>
cd fitai-pro
vercel deploy
```

### 2. Configurer Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Exécuter `supabase/schema.sql` dans le SQL Editor
3. Créer le bucket `user_uploads` dans Storage (privé)
4. Configurer Authentication → URL Configuration:
   - Site URL: `https://votre-app.vercel.app`
   - Redirect URLs: `https://votre-app.vercel.app/**`

### 3. Variables d'environnement Vercel

Dans Vercel Dashboard → Settings → Environment Variables:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Clé publique (anon) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service (pour API) |
| `GEMINI_API_KEY` | Clé Google AI Studio |
| `ALLOWED_ORIGIN` | (optionnel) Domaine autorisé |

### 4. Redéployer

```bash
vercel --prod
```

## 📁 Structure

```
fitai-pro/
├── api/
│   ├── config.js      # Config endpoint
│   ├── workout.js     # Coach IA
│   └── bodyscan.js    # Body Scan IA
├── lib/
│   └── logger.js      # Structured logging
├── public/
│   ├── index.html     # SPA
│   └── app.js         # Frontend logic
├── supabase/
│   └── schema.sql     # Database schema
├── vercel.json        # Vercel config
└── package.json
```

## 🔒 Sécurité

- Row Level Security (RLS) sur toutes les tables
- Validation des tokens côté API
- Input sanitization
- CORS restrictif en production
- Headers de sécurité (X-Frame-Options, CSP, etc.)
- Fonction RPC sécurisée pour kudos (anti-exploit)

## 🎯 Roadmap

### Phase 1 ✅ (actuel)
- [x] Coach IA amélioré
- [x] Body Scan enrichi
- [x] Système de commentaires
- [x] Streaks automatiques
- [x] Sécurité renforcée

### Phase 2 (à venir)
- [ ] Posts avec images
- [ ] Leaderboard streaks
- [ ] Achievements/badges
- [ ] Export PDF des programmes

### Phase 3 (futur)
- [ ] PWA + notifications
- [ ] Mode offline
- [ ] Multi-langue
- [ ] Intégration wearables

## 📄 Licence

Propriétaire - Tous droits réservés

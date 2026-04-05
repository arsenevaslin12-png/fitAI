# FitAI Pro — GitHub-ready package

Cette archive contient un seul projet propre à la racine, prêt à être uploadé dans GitHub.

## Nettoyage appliqué
- suppression des doublons mal placés à la racine (`index.html`, `config.js`, `logger.js`, `workout.js`)
- suppression du fichier parasite `download`
- suppression des fichiers de backup `.bak`
- suppression des rapports temporaires de fusion / patch / nettoyage

## Structure conservée
- `api/`
- `public/`
- `supabase/`
- `lib/`
- `package.json`
- `vercel.json`
- `README.md`
- `env.example`

## Recommandation
Avant push GitHub / déploiement Vercel, vérifier les variables d'environnement :
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`

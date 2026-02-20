# fitAI

Application web FitAI (Vercel + Supabase + Gemini).

## Développement

- Runtime: Node 20.x
- Front: `public/index.html` + `public/app.js`
- API serverless: `api/*.js`

## Vérifications minimales avant release

1. Auth Supabase (magic link, logout)
2. Feed workouts (lecture, kudos)
3. Coach (génération + fallback)
4. Body scan (upload image + lecture signed URL)
5. Vérifier console navigateur: aucune erreur non gérée

## Notes

Les dépendances `node_modules/` sont exclues du dépôt via `.gitignore`.

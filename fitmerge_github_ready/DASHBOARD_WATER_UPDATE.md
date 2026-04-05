# Dashboard + Water fix

## Correctifs
- Dashboard: carte séance du jour plus claire et dynamique
- Dashboard: résumé objectif / cycle / hydratation
- Programme: compteur d'eau synchronisé avec le vrai store global
- Programme: clic sur les verres corrigé

## Cause eau
Le programme lisait encore d'anciennes clés localStorage (`fitai_water_count`, `fitai_water_target`) au lieu du store actuel `fitai_water`.

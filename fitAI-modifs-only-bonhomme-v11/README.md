# Bonhomme workout — modifs only v11

Ce dossier contient uniquement les changements utiles pour rendre le bonhomme du workout vraiment animé, sans renvoyer tout le projet.

## Contenu
- `public-app-js.patch` : patch JS principal
- `public-index-bonhomme-snippet.css.txt` : CSS à ajouter pour afficher l'avatar animé en inline avec des motions visibles

## Idée
- Remplacer le rendu `img` statique du workout par le SVG animé inline déjà présent dans `public/app.js`
- Ajouter un wrapper `.wt-demo-figure` / `.wt-next-figure` et des animations CSS par type d'exercice
- Animer aussi la preview `Ensuite`

## Fichiers cibles dans le repo
- `public/app.js`
- `public/index.html`

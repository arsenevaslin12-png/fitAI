async function getWorkout() {
    const box = document.getElementById('workout-box');
    box.innerText = "Calcul du coach...";
    
    // Simule l'appel API
    setTimeout(() => {
        box.innerHTML = "<strong>SÉANCE D'AUJOURD'HUI</strong><br>10 Tractions - Repos 2min - 12 Pompes";
        alert("Séance générée ! N'oublie pas de noter tes perfs à la fin.");
    }, 1000);
}

function savePerf() {
    const r = document.getElementById('reps').value;
    const d = document.getElementById('rpe').value;
    alert(`Perf enregistrée : ${r} reps (Difficulté ${d}/10). Ton pote va être fier !`);
}

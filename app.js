async evaluateAchievements() {
    // Client-side achievement evaluation (complémentaire aux triggers DB)
    if (!this.user) return;
    
    // Check STREAK (3 jours consécutifs)
    const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data: recentWorkouts } = await this.supabase
      .from("workouts")
      .select("created_at")
      .eq("user_id", this.user.id)
      .gte("created_at", threeDaysAgo)
      .order("created_at", { ascending: true });

    if (recentWorkouts && recentWorkouts.length >= 3) {
      // Vérifier si c'est bien 3 jours différents
      const uniqueDays = new Set(recentWorkouts.map(w => new Date(w.created_at).toDateString()));
      if (uniqueDays.size >= 3) {
        await this.supabase
          .from("achievements")
          .insert({ user_id: this.user.id, badge_type: "STREAK" })
          .onConflict("user_id,badge_type")
          .ignore();
      }
    }

    // Check MACHINE (3 séances Hard dans la semaine ISO)
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1); // Lundi
    startOfWeek.setHours(0, 0, 0, 0);

    const { data: hardWorkouts } = await this.supabase
      .from("workouts")
      .select("id")
      .eq("user_id", this.user.id)
      .eq("intensity", "hard")
      .gte("created_at", startOfWeek.toISOString());

    if (hardWorkouts && hardWorkouts.length >= 3) {
      await this.supabase
        .from("achievements")
        .insert({ user_id: this.user.id, badge_type: "MACHINE" })
        .onConflict("user_id,badge_type")
        .ignore();
    }

    // Check CLOWN (Séance Light avec Recovery ≥ 90%)
    if (this.profile?.kpis?.recovery >= 90) {
      const { data: lightWorkouts } = await this.supabase
        .from("workouts")
        .select("id")
        .eq("user_id", this.user.id)
        .eq("intensity", "light")
        .limit(1);

      if (lightWorkouts && lightWorkouts.length > 0) {
        await this.supabase
          .from("achievements")
          .insert({ user_id: this.user.id, badge_type: "CLOWN" })
          .onConflict("user_id,badge_type")
          .ignore();
      }
    }

    // KUDOS_KING est géré par le trigger DB (auto-award à 11 kudos)
  },

  async refreshTrophies() {
    if (!this.user) return this.renderTrophyWall(new Map());
    
    const { data, error } = await this.supabase
      .from("achievements")
      .select("badge_type,unlocked_at")
      .eq("user_id", this.user.id);

    if (error) {
      console.error("Error loading trophies:", error);
      this.hint("trophyHint", "Erreur lors du chargement des trophées.", "err");
      return this.renderTrophyWall(new Map());
    }

    const unlocked = new Map((data || []).map(a => [a.badge_type, a.unlocked_at]));
    this.renderTrophyWall(unlocked);
    this.hint("trophyHint", `${unlocked.size}/4 trophées débloqués.`, "ok");
  },

  renderTrophyWall(unlocked) {
    const c = this.$("trophyWall");
    c.innerHTML = "";
    
    Object.entries(BADGES).forEach(([key, badge]) => {
      const unlockedAt = unlocked.get(key);
      const isUnlocked = !!unlockedAt;
      
      const card = this.el("div", { 
        className: "trophyCard" + (isUnlocked ? " unlocked" : " locked") 
      }, [
        this.el("div", { className: "trophyIcon", text: badge.emoji }),
        this.el("div", { className: "trophyInfo" }, [
          this.el("div", { className: "trophyTitle", text: badge.title }),
          this.el("div", { className: "trophyDesc", text: badge.desc }),
          isUnlocked 
            ? this.el("div", { 
                className: "trophyMeta", 
                text: `Débloqué le ${new Date(unlockedAt).toLocaleDateString("fr-FR")}` 
              }) 
            : this.el("div", { 
                className: "trophyMeta", 
                text: "🔒 Non débloqué" 
              })
        ])
      ]);
      c.appendChild(card);
    });
  },

  // ==================== NUTRITION ====================
  showMealModal() {
    this.$("mealModal").style.display = "block";
    // Reset form
    this.$("mealType").value = "Petit-déj";
    this.$("mealDesc").value = "";
    this.$("mealCal").value = "";
    this.$("mealProt").value = "";
    this.$("mealCarbs").value = "";
    this.$("mealFats").value = "";
  },

  hideMealModal() {
    this.$("mealModal").style.display = "none";
  },

  async saveMeal() {
    const meal = {
      type: this.$("mealType").value,
      desc: this.$("mealDesc").value.trim(),
      cal: Number(this.$("mealCal").value) || 0,
      prot: Number(this.$("mealProt").value) || 0,
      carbs: Number(this.$("mealCarbs").value) || 0,
      fats: Number(this.$("mealFats").value) || 0,
      date: new Date().toISOString()
    };

    if (!meal.desc || meal.cal === 0) {
      alert("Description et calories obligatoires.");
      return;
    }

    // Save to local state (in production, save to Supabase nutrition table)
    this.meals.push(meal);
    this.hideMealModal();
    this.renderNutrition();

    // TODO: Uncomment when nutrition table exists
    /*
    if (this.user) {
      await this.supabase.from("nutrition_logs").insert({
        user_id: this.user.id,
        meal_type: meal.type,
        description: meal.desc,
        calories: meal.cal,
        protein: meal.prot,
        carbs: meal.carbs,
        fats: meal.fats,
        logged_at: meal.date
      });
    }
    */
  },

  renderNutrition() {
    const today = this.meals.filter(m => 
      new Date(m.date).toDateString() === new Date().toDateString()
    );
    
    const totalCal = today.reduce((s, m) => s + m.cal, 0);
    const totalProt = today.reduce((s, m) => s + m.prot, 0);
    const totalCarbs = today.reduce((s, m) => s + m.carbs, 0);
    const totalFats = today.reduce((s, m) => s + m.fats, 0);

    // Update summary
    this.$("cal-total").textContent = totalCal;
    this.$("macro-protein").textContent = totalProt + "g";
    this.$("macro-carbs").textContent = totalCarbs;
    this.$("macro-fats").textContent = totalFats;

    // Render meal cards
    const c = this.$("mealsContainer");
    c.innerHTML = "";
    
    if (!today.length) {
      c.appendChild(this.el("div", { 
        className: "empty", 
        text: "Aucun repas enregistré aujourd'hui. Clique sur '+ Ajouter un Repas'." 
      }));
      return;
    }

    today.forEach((m, idx) => {
      const card = this.el("div", { className: "mealCard" }, [
        this.el("div", { className: "mealHeader" }, [
          this.el("div", { className: "mealType", text: m.type }),
          this.el("span", { className: "badge cyan", text: `${m.cal} kcal` })
        ]),
        this.el("div", { 
          text: m.desc, 
          style: { fontSize: "13px", color: "var(--muted)", marginBottom: "8px" } 
        }),
        this.el("div", { className: "mealMacros" }, [
          this.el("span", { text: `P: ${m.prot}g` }),
          this.el("span", { text: `G: ${m.carbs}g` }),
          this.el("span", { text: `L: ${m.fats}g` })
        ])
      ]);
      c.appendChild(card);
    });

    // Auto-calculate target based on weight (if available)
    if (this.profile?.kpis?.weight) {
      const weight = Number(this.profile.kpis.weight);
      const proteinTarget = Math.round(weight * 2); // 2g/kg pour muscle building
      const calTarget = Math.round(weight * 30); // Approximation maintenance
      this.$("protein-target").textContent = proteinTarget;
      this.$("cal-target").textContent = calTarget;
    }
  },

  // ==================== CHARTS ====================
  initCharts() {
    const ctx = this.$("chartVolume")?.getContext("2d");
    if (!ctx) return;

    this.chartVolume = new Chart(ctx, {
      type: "line",
      data: {
        labels: ["S-4", "S-3", "S-2", "S-1", "Maintenant"],
        datasets: [{
          label: "Volume (kg)",
          data: [0, 0, 0, 0, 0],
          borderColor: "#b7ff2a",
          backgroundColor: "rgba(183,255,42,.10)",
          tension: 0.4,
          fill: true,
          borderWidth: 3,
          pointRadius: 5,
          pointBackgroundColor: "#b7ff2a"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(0,0,0,.85)",
            titleColor: "#b7ff2a",
            bodyColor: "#fff",
            borderColor: "#b7ff2a",
            borderWidth: 1
          }
        },
        scales: {
          y: { 
            beginAtZero: true, 
            ticks: { color: "#a7adbd", font: { size: 11 } }, 
            grid: { color: "rgba(255,255,255,.05)" } 
          },
          x: { 
            ticks: { color: "#a7adbd", font: { size: 11 } }, 
            grid: { display: false } 
          }
        }
      }
    });

    // Load initial data
    this.updateVolumeChart();
  },

  async updateVolumeChart() {
    if (!this.chartVolume || !this.user) return;

    // Fetch workout volume for last 5 weeks
    const weeks = [];
    const volumes = [];
    
    for (let i = 4; i >= 0; i--) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (i * 7));
      weekStart.setHours(0, 0, 0, 0);
      
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      
      const { data } = await this.supabase
        .from("workouts")
        .select("exercises")
        .eq("user_id", this.user.id)
        .gte("created_at", weekStart.toISOString())
        .lt("created_at", weekEnd.toISOString());

      // Calculate total volume (sets × reps × estimated weight)
      let weekVolume = 0;
      if (data) {
        data.forEach(w => {
          if (w.exercises && Array.isArray(w.exercises)) {
            w.exercises.forEach(ex => {
              // Estimation: volume = sets × moyenne(reps) × 50kg
              const sets = ex.sets || 3;
              const repsRange = String(ex.reps || "8-10").split("-");
              const avgReps = repsRange.length === 2 
                ? (Number(repsRange[0]) + Number(repsRange[1])) / 2 
                : Number(repsRange[0]) || 8;
              weekVolume += sets * avgReps * 50; // 50kg estimation moyenne
            });
          }
        });
      }
      
      weeks.push(i === 0 ? "Maintenant" : `S-${i}`);
      volumes.push(Math.round(weekVolume));
    }

    this.chartVolume.data.labels = weeks;
    this.chartVolume.data.datasets[0].data = volumes;
    this.chartVolume.update();
  }
};

// ==================== APP INIT ====================
document.addEventListener("DOMContentLoaded", () => App.init());

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Save, X, Dumbbell, Clock, Flame, Loader2 } from 'lucide-react'

export default function CoachIA() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [plan, setPlan] = useState(null)

  const { data: goal } = useQuery({
    queryKey: ['goal', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('goals').select('*').eq('user_id', user.id).maybeSingle()
      return data
    },
    enabled: !!user
  })

  const { data: history = [] } = useQuery({
    queryKey: ['sessions', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('workout_sessions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10)
      return data ?? []
    },
    enabled: !!user
  })

  const generate = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ prompt, goalContext: goal ? { type: goal.type, level: goal.level, text: goal.text, constraints: goal.constraints } : null })
      })
      const j = await res.json()
      if (!j.ok) {
        if (j.error === 'GEMINI_QUOTA') throw new Error('quota')
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      return j.data
    },
    onSuccess: (data) => { setPlan(data) },
    onError: (err) => {
      if (err.message === 'quota') {
        toast.error('Quota Gemini atteint — réessaie dans 30 secondes')
      } else {
        toast.error('Erreur: ' + err.message)
      }
    }
  })

  const save = useMutation({
    mutationFn: async () => {
      if (!plan) return
      const { error } = await supabase.from('workout_sessions').insert({
        user_id: user.id,
        title: plan.title,
        type: plan.type,
        duration: plan.duration,
        intensity: plan.intensity,
        blocks: plan.blocks,
        notes: plan.notes,
        calories_burned: plan.calories_burned
      })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Séance sauvegardée ✓')
      setPlan(null)
      setPrompt('')
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error('Erreur: ' + err.message)
  })

  const intensityColor = { low: 'bg-green-100 text-green-700', medium: 'bg-blue-100 text-blue-700', high: 'bg-orange-100 text-orange-700' }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-black text-gray-900">🤖 Coach IA</h1>
        <p className="text-sm text-gray-500 mt-1">Générez des séances personnalisées avec l'IA</p>
      </div>

      {/* Generate card */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4">Générer une séance</h2>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Ex: HIIT 30 min sans matériel, focus cardio et abdos…"
          className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm resize-none h-24 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
        />
        <button
          onClick={() => generate.mutate()}
          disabled={!prompt.trim() || generate.isPending}
          className="mt-3 w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-sm shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {generate.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generate.isPending ? 'Génération en cours…' : 'Générer ma séance'}
        </button>
      </div>

      {/* Plan result */}
      <AnimatePresence>
        {plan && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm"
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="font-black text-gray-900 text-lg">{plan.title}</h3>
                <div className="flex gap-2 mt-2 flex-wrap">
                  <span className={`text-xs font-bold px-3 py-1 rounded-full ${intensityColor[plan.intensity] ?? 'bg-gray-100 text-gray-600'}`}>{plan.intensity}</span>
                  {plan.duration && <span className="text-xs font-bold px-3 py-1 rounded-full bg-gray-100 text-gray-600 flex items-center gap-1"><Clock className="w-3 h-3" />{plan.duration} min</span>}
                  {plan.calories_burned && <span className="text-xs font-bold px-3 py-1 rounded-full bg-orange-50 text-orange-600 flex items-center gap-1"><Flame className="w-3 h-3" />~{plan.calories_burned} kcal</span>}
                </div>
              </div>
              <button onClick={() => setPlan(null)} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
            </div>
            {plan.notes && <p className="text-sm text-gray-500 italic mb-4">{plan.notes}</p>}
            <div className="space-y-3">
              {plan.blocks?.map((block, i) => (
                <div key={i} className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-sm text-gray-900">{block.title}</span>
                    <div className="flex gap-2">
                      {block.rpe && <span className="text-xs bg-purple-100 text-purple-700 font-bold px-2 py-0.5 rounded-full">RPE {block.rpe}</span>}
                      <span className="text-xs text-gray-400">{Math.round(block.duration_sec / 60)} min</span>
                    </div>
                  </div>
                  <ul className="space-y-1">
                    {block.items?.map((item, j) => (
                      <li key={j} className="text-sm text-gray-700 flex items-start gap-2">
                        <span className="text-blue-500 font-bold mt-0.5">→</span>{item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => save.mutate()} disabled={save.isPending}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Sauvegarder
              </button>
              <button onClick={() => setPlan(null)} className="px-5 py-2.5 rounded-xl bg-gray-100 text-gray-700 font-bold text-sm hover:bg-gray-200 transition-colors">
                Fermer
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4 flex items-center gap-2"><Dumbbell className="w-4 h-4" />Historique</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Aucune séance sauvegardée</p>
        ) : (
          <div className="space-y-2">
            {history.map(s => (
              <div key={s.id} className="flex items-center justify-between py-3 border-b border-gray-50 last:border-0">
                <div>
                  <p className="font-semibold text-gray-900 text-sm">{s.title}</p>
                  <p className="text-xs text-gray-400">{new Date(s.created_at).toLocaleDateString('fr-FR')}</p>
                </div>
                <span className="text-xs text-gray-500">{s.duration ?? '—'} min</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

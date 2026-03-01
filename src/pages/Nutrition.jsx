import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Plus, Trash2, Flame, Loader2 } from 'lucide-react'

const MACRO_CFG = [
  { key: 'calories', label: 'Calories', icon: '🔥', color: 'text-orange-600' },
  { key: 'protein',  label: 'Protéines', icon: '🎯', color: 'text-blue-600' },
  { key: 'carbs',    label: 'Glucides',  icon: 'G',  color: 'text-green-600', letter: true },
  { key: 'fat',      label: 'Lipides',   icon: 'L',  color: 'text-yellow-600', letter: true },
]

export default function Nutrition() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({ name: '', calories: '', protein: '', carbs: '', fat: '' })
  const [activeTab, setActiveTab] = useState('today')

  const { data: meals = [], isLoading } = useQuery({
    queryKey: ['meals', user?.id, today],
    queryFn: async () => {
      const { data, error } = await supabase.from('meals')
        .select('*').eq('user_id', user.id).eq('date', today).order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!user
  })

  const totals = meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories ?? 0),
    protein:  acc.protein  + (m.protein  ?? 0),
    carbs:    acc.carbs    + (m.carbs    ?? 0),
    fat:      acc.fat      + (m.fat      ?? 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 })

  const addMeal = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('meals').insert({
        user_id: user.id,
        name: form.name,
        calories: Number(form.calories) || 0,
        protein:  Number(form.protein)  || 0,
        carbs:    Number(form.carbs)    || 0,
        fat:      Number(form.fat)      || 0,
        date: today
      })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Repas ajouté ✓')
      setForm({ name: '', calories: '', protein: '', carbs: '', fat: '' })
      qc.invalidateQueries({ queryKey: ['meals'] })
    },
    onError: e => toast.error('Erreur: ' + e.message)
  })

  const delMeal = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('meals').delete().eq('id', id).eq('user_id', user.id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Repas supprimé'); qc.invalidateQueries({ queryKey: ['meals'] }) },
    onError: e => toast.error(e.message)
  })

  const f = (v) => { setForm(p => ({ ...p, ...v })) }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900">Nutrition</h1>
          <p className="text-sm text-gray-500 mt-1">Plan alimentaire personnalisé</p>
        </div>
      </div>

      {/* Macro totals */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
        <div className="grid grid-cols-4 gap-2">
          {MACRO_CFG.map(m => (
            <div key={m.key} className="text-center">
              {m.letter
                ? <div className={`w-7 h-7 rounded-full mx-auto mb-2 flex items-center justify-center text-xs font-black ${m.key === 'carbs' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{m.icon}</div>
                : <div className="text-2xl mb-1 text-center">{m.icon}</div>
              }
              <div className={`text-xl font-black ${m.color}`}>
                {totals[m.key]}{m.key !== 'calories' ? 'g' : ''}
              </div>
              <div className="text-[11px] text-gray-400 font-medium">{m.label}</div>
            </div>
          ))}
        </div>

        {/* Sub-tabs */}
        <div className="flex border-b border-gray-100 mt-4 gap-0">
          {["Aujourd'hui", 'Macros', 'Planning'].map(t => (
            <button key={t} onClick={() => setActiveTab(t.toLowerCase())}
              className={`flex-1 py-2.5 text-sm font-semibold border-b-2 transition-colors ${activeTab === t.toLowerCase() ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-400'}`}
            >{t}</button>
          ))}
        </div>
      </div>

      {/* Add meal form */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4 flex items-center gap-2"><Plus className="w-4 h-4" />Ajouter un repas</h2>
        <div className="space-y-3">
          <input value={form.name} onChange={e => f({ name: e.target.value })}
            placeholder="Nom du repas (ex: Poulet riz légumes)"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
          />
          <div className="grid grid-cols-2 gap-3">
            <input type="number" value={form.calories} onChange={e => f({ calories: e.target.value })} placeholder="Calories (kcal)"
              className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 transition-all"
            />
            <input type="number" value={form.protein} onChange={e => f({ protein: e.target.value })} placeholder="Protéines (g)"
              className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 transition-all"
            />
            <input type="number" value={form.carbs} onChange={e => f({ carbs: e.target.value })} placeholder="Glucides (g)"
              className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 transition-all"
            />
            <input type="number" value={form.fat} onChange={e => f({ fat: e.target.value })} placeholder="Lipides (g)"
              className="px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:border-blue-500 transition-all"
            />
          </div>
          <button onClick={() => { if (!form.name) return toast.error('Entrez un nom'); addMeal.mutate() }}
            disabled={addMeal.isPending}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {addMeal.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Ajouter ce repas
          </button>
        </div>
      </div>

      {/* Meals list */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
        <h2 className="font-bold text-gray-900 mb-4">Repas du jour</h2>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
        ) : meals.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">Aucun repas enregistré aujourd'hui</p>
        ) : (
          <div className="space-y-2">
            {meals.map(m => (
              <div key={m.id} className="flex items-center justify-between py-3 border-b border-gray-50 last:border-0">
                <div className="flex-1">
                  <p className="font-semibold text-gray-900 text-sm">{m.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                    <Flame className="w-3 h-3 text-orange-400" />{m.calories} kcal
                    {m.protein > 0 && ` · P ${m.protein}g`}
                    {m.carbs > 0 && ` · G ${m.carbs}g`}
                    {m.fat > 0 && ` · L ${m.fat}g`}
                  </p>
                </div>
                <button onClick={() => delMeal.mutate(m.id)} className="ml-3 p-2 text-gray-300 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

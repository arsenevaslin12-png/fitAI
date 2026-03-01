import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Flame, Target, Clock, Zap, ChevronRight, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

function StatCard({ icon: Icon, value, label, color }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center text-white shadow-lg mb-3', color)}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="text-2xl font-black text-gray-900">{value}</div>
      <div className="text-xs text-gray-500 font-medium mt-0.5">{label}</div>
    </div>
  )
}

export default function Dashboard() {
  const { user } = useAuth()

  const { data: goal } = useQuery({
    queryKey: ['goal', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('goals').select('*').eq('user_id', user.id).maybeSingle()
      return data
    },
    enabled: !!user
  })

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('workout_sessions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20)
      return data ?? []
    },
    enabled: !!user
  })

  const firstName = user?.email?.split('@')[0] ?? 'Athlète'
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const lastWeekSessions = sessions.filter(s => {
    const d = new Date(s.created_at)
    return (Date.now() - d.getTime()) < 7 * 24 * 60 * 60 * 1000
  })
  const noSession = lastWeekSessions.length === 0

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">Bonjour 👋</p>
          <h1 className="text-3xl font-black text-gray-900 mt-0.5 capitalize">{firstName}</h1>
        </div>
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-full px-4 py-2 text-sm text-gray-500 shadow-sm">
          <Zap className="w-3.5 h-3.5 text-blue-500" />
          {today}
        </div>
      </div>

      {/* Goal card */}
      {goal && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Link to="/coach-ia" className="flex items-center gap-4 bg-white rounded-2xl border border-gray-100 p-5 shadow-sm hover:shadow-md transition-all group">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center flex-shrink-0 shadow-lg">
              <Target className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold text-blue-600 uppercase tracking-wider">Mon objectif</p>
              <p className="font-bold text-gray-900 mt-0.5 capitalize">{goal.type?.replace(/_/g, ' ') ?? 'Non défini'}</p>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-gray-500 transition-colors" />
          </Link>
        </motion.div>
      )}

      {/* AI suggestion */}
      {noSession && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
            <div className="flex items-center gap-3 mb-2">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
              <h3 className="font-bold text-red-800">Reprenez l'entraînement</h3>
            </div>
            <p className="text-sm text-red-700 ml-8">Aucune séance détectée cette semaine. Commencez par une séance avec le Coach IA.</p>
            <Link to="/coach-ia" className="ml-8 mt-3 inline-block text-sm font-bold text-red-600 hover:underline">
              Démarrer →
            </Link>
          </div>
        </motion.div>
      )}

      {/* Stats */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={Flame} value="0" label="Calories brûlées" color="bg-gradient-to-br from-orange-500 to-red-500" />
          <StatCard icon={Target} value={lastWeekSessions.length} label="Séances / semaine" color="bg-gradient-to-br from-blue-500 to-cyan-500" />
          <StatCard icon={Clock} value="0h" label="Temps total" color="bg-gradient-to-br from-green-500 to-emerald-500" />
          <StatCard icon={Zap} value="—" label="Énergie moyenne" color="bg-gradient-to-br from-purple-500 to-pink-500" />
        </div>
      </motion.div>

      {/* Recent sessions */}
      {sessions.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <h3 className="font-bold text-gray-900 mb-4">Dernières séances</h3>
            <div className="space-y-3">
              {sessions.slice(0, 5).map(s => (
                <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{s.title ?? 'Séance'}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{new Date(s.created_at).toLocaleDateString('fr-FR')}</p>
                  </div>
                  <span className="text-xs bg-blue-50 text-blue-700 font-bold px-3 py-1 rounded-full">{s.duration ?? '—'} min</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}

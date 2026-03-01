import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { Dumbbell, Clock, Flame } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function Workouts() {
  const { user } = useAuth()
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['sessions-all', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('workout_sessions').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
      return data ?? []
    },
    enabled: !!user
  })

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900">🏋️ Entraînements</h1>
          <p className="text-sm text-gray-500 mt-1">Historique de toutes vos séances</p>
        </div>
        <Link to="/coach-ia" className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all">
          + Nouvelle séance
        </Link>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-12">
            <Dumbbell className="w-12 h-12 mx-auto mb-3 text-gray-200" />
            <p className="text-gray-400 text-sm">Aucune séance — générez-en une avec le Coach IA</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {sessions.map(s => (
              <div key={s.id} className="flex items-center gap-4 p-5 hover:bg-gray-50/50 transition-colors">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-100 to-purple-100 flex items-center justify-center flex-shrink-0">
                  <Dumbbell className="w-5 h-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-gray-900 truncate">{s.title ?? 'Séance'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{new Date(s.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                </div>
                <div className="flex gap-3 text-xs text-gray-400 flex-shrink-0">
                  {s.duration && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{s.duration} min</span>}
                  {s.calories_burned && <span className="flex items-center gap-1"><Flame className="w-3 h-3 text-orange-400" />{s.calories_burned}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
